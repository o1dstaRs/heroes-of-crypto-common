# UI screen-stage compatibility

This companion change records the common-package boundary for the consolidated game-screen design work in the
client.

- The client continues to consume the existing pick, placement, fight, and finished phase values.
- Existing action and snapshot types remain the source of truth for timers, readiness, roster visibility, and
  post-fight data.
- Loading progress, preview-only screen fixtures, layout, typography, fullscreen controls, and visual transitions
  remain client concerns.
- No creature definition, combat rule, unit-state field, action payload, protobuf schema, or AI policy is changed by
  this UI delivery.

Accordingly, the common package requires no runtime or wire-format delta for the companion client PR.
