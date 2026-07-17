# v0.7 non-fight 11-hour result

This directory preserves the terminal decision for campaign
`c77bae00-909a-4095-bb12-27dbe9b796bb`.

The decision is `accepted_setup_only`. The setup policy independently passed its
untouched guard: 12,288 pairs, 24,576 games, 53.9972% decisive, and a +3.1149pp
clustered lower gain bound, with every named cohort and map above its floor and
zero setup rejections. Its frozen spec is `v07-nonfight-4eda84635fe7`.

The combined draft-plus-setup guard completed, but it is not eligible. Its
32,000-game natural panel reached 56.1082% decisive with a 55.0180% clustered
lower bound. The targeted mage panel reached only 47.3758%, with a 45.4240%
lower bound, missing the preregistered 49.5% point and 48% lower-bound floors.
Those were the only two failed checks: 21 of 23 composed checks passed. The new draft genome therefore remains an
explicit opt-in (`v07-nonfight-draft-48d23ac4461`) and is not promoted or made
the default by this result.

## Exact archive

| File | SHA-256 of exact bytes |
| --- | --- |
| `campaign-run.json` | `2b5e5d27fe5b8cac8905fce7155b2d30917be06efda1371279a97da709ed38b2` |
| `campaign-terminal.json` | `784cf446c162f8a0e321b4c183de51503b99b25fb2e102371c2e556421982e05` |
| `draft-verdict.json` | `daa7dd631d833f7548c6d5448bc0ab7c4afca9a9e9a462852ebec38cec60f9f4` |
| `composed-manifest.json` | `1cce8972bec52ea6c60907a3decd31b4ea4006d6c0c2d2c7b6a532f350711495` |
| `composed-report.json` | `d3725240157132c5580b245afc5117084d018b6661af69776bda38be427d57c5` |
| `composed-outcome.json` | `371f558a238320d37c97f581ebfc6906dd75a9b64393f9bbbaae888f98df7217` |
| `campaign.expected.env` | `fc19b4a117a07d74c47716488efdd5a5d9d1281aad32b15369d1125a1dc9ae1e` |
| `guard.expected.env` | `ef92ed546c9fdcf09afa0425187190f4c20b74bdea70b20d4bb1df70dfbfea0c` |

The two attestation files are byte-exact copies of the prelaunch records; their
source files were mode `0440`. Git does not preserve read-only permission bits,
so `promotion-report.json` records the source mode rather than claiming the archived
copies retain it.

The 100,950,708-byte final checkpoint is deliberately not duplicated. The
promotion record binds its exact byte SHA-256
`48d4766412a3a2cab95f54eb05366b4aecb094c06a68324e74022c2c58f97b57`
and self-hash
`44611bbaee4ff8a24d9a78314758c58bc43c613eff68e814e26d36883655927b`.
The original campaign output remains the full evidence source.

`promotion-report.json` is the compact, self-hashed owner decision. It grants no
production enablement or deploy authorization.
