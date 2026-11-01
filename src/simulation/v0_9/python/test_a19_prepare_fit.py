"""Malformed data must fail CPU admission before CUDA initialization."""
import copy
import unittest

from a19_prepare_fit import check_observation


class CorpusAdmissionTests(unittest.TestCase):
    def test_valid_shapes_and_finite_features_are_required_for_every_observation(self):
        contract = {"schema": "fixture", "contractSha256": "contract", "entities": ["own"],
                    "candidates": ["damage"], "globals": ["lap"], "maximumEntities": 64, "maximumCandidates": 256}
        observation = {"schema": "fixture", "contractSha256": "contract", "entities": [[1], [0]],
                       "entityIds": ["a", "b"], "actorIndex": 0, "globals": [1], "terrain": [0] * 256,
                       "candidates": [{"signature": "attack", "features": [1], "targetIndex": 1},
                                      {"signature": "wait", "features": [0], "targetIndex": -1}]}
        check_observation(observation, contract)
        for mutate in (
            lambda row: row["globals"].__setitem__(0, float("nan")),
            lambda row: row["entities"][0].append(1),
            lambda row: row["entityIds"].__setitem__(1, "a"),
            lambda row: row["terrain"].__setitem__(0, 1.5),
            lambda row: row["candidates"][0].__setitem__("targetIndex", 2),
            lambda row: row["candidates"][1].__setitem__("signature", "attack"),
        ):
            changed = copy.deepcopy(observation)
            mutate(changed)
            with self.assertRaisesRegex(ValueError, "CPU scan"):
                check_observation(changed, contract)


if __name__ == "__main__":
    unittest.main()
