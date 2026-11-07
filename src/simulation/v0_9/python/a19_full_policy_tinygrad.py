"""Original-width full-policy fine tuning; no frozen feature cache or new serving layer."""
import numpy as np
from tinygrad import Tensor
from a19_feature_tinygrad import TinyA19HeadPair,pack_observations,served_log_policy

class FullA19Pair(TinyA19HeadPair):
    def __init__(self,student,partner,widths,*,device,train_members='joint'):
        if train_members!='joint':raise ValueError('This registered full-policy fit trains both members')
        super().__init__(student,partner,widths,device=device,train_members=train_members)
        self.parameters=[];self.names=[]
        for role in ['student','partner']:
            for name,p in self.models[role].items():
                trainable=not name.startswith(('primary.','value.'));p.is_param_(trainable)
                if trainable:self.parameters.append(p);self.names.append(role+'/'+name)

    def cache(self,observations):
        arrays=pack_observations(observations,self.widths)
        cache={name:Tensor(array.copy(),device=self.device) for name,array in arrays.items()}
        cache['legalArray']=arrays['legal']
        return cache

    def features(self,cache):
        x=cache;own=x['mask']&(x['entities'][:,:,0]>.5);enemy=x['mask']&~own
        batch,count=x['legalArray'].shape;result=[]
        for role in ['student','partner']:
            encoded=self._dense(role,'entity.2',self._dense(role,'entity.0',x['entities'],True),True)
            actor=(encoded*x['actor'].unsqueeze(-1)).sum(axis=1)
            terrain=self._dense(role,'terrain.0',x['terrain'],True)
            context=self._dense(role,'context.0',Tensor.cat(self._pool(encoded,own),self._pool(encoded,enemy),actor,x['globals'],terrain,dim=-1),True)
            target=x['target'].matmul(encoded)
            candidate=Tensor.cat(context.reshape(batch,1,128).expand(batch,count,128),target,x['candidates'],dim=-1)
            feature=self._dense(role,'candidate.2',self._dense(role,'candidate.0',candidate,True),True)
            result.append((feature,context))
        return result

    def policy(self,cache):
        logits=[self._dense(role,'policy',feature).squeeze(-1) for role,(feature,_) in zip(['student','partner'],self.features(cache))]
        return served_log_policy(*logits,cache['legal'])

    def predictions(self,cache):
        result=[]
        for role,(feature,context) in zip(['student','partner'],self.features(cache)):
            result.append({'policy':self._dense(role,'policy',feature).squeeze(-1).numpy(),
                'primary':self._dense(role,'primary',feature).squeeze(-1).numpy(),
                'valueLogit':self._dense(role,'value.2',self._dense(role,'value.0',context,True)).squeeze(-1).numpy()})
        return result

    def check_frozen_parameters(self):
        for role,weights in self.models.items():
            for name,p in weights.items():
                trainable=not name.startswith(('primary.','value.'))
                if bool(p.is_param)!=trainable:raise ValueError('Full-policy parameter scope changed')
                if not trainable and not np.array_equal(p.numpy(),self.initial[role][name]):raise ValueError('Frozen auxiliary-head weights changed')

    def snapshot(self):return [{name:p.numpy().copy() for name,p in self.models[role].items()} for role in ['student','partner']]

    def restore(self,snapshot):
        if len(snapshot)!=2:raise ValueError('Incomplete full-policy snapshot')
        for role,weights in zip(['student','partner'],snapshot):
            if set(weights)!=set(self.models[role]):raise ValueError('Incomplete full-policy member')
            for name,array in weights.items():
                if array.shape!=self.initial[role][name].shape or array.dtype!=np.float32 or not np.isfinite(array).all():raise ValueError('Invalid full-policy snapshot')
                if name.startswith(('primary.','value.')) and not np.array_equal(array,self.initial[role][name]):raise ValueError('Snapshot modified frozen auxiliary weights')
        for role,weights in zip(['student','partner'],snapshot):
            for name,array in weights.items():self.models[role][name].assign(Tensor(array.copy(),device=self.device)).realize()
        self.check_frozen_parameters()
