# Contributing to Cadre

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

Open an [issue](../../issues/new/choose) with the bug report or feature request template. For bugs, include your OS,
the Cadre version (Settings › About) and the relevant lines of the log (`~/Library/Logs/Cadre/cadre.log` on macOS).

## Setting up

See [Development](README.md#development) in the README. In short: `uv sync` in `engine/`, `pnpm install` in `web/`
(and `desktop/` for the app shell), then run the engine and `pnpm dev`.

## Before opening a pull request

- `cd web && npx tsc -b` passes, and `pnpm build` works.
- Python changes import cleanly: `cd engine && uv run python -c "import cadre_engine.main"`.
- New UI text is wrapped in `tx('…')` and translated in every `web/src/lib/locales/*.json` file
  (`node web/scripts/i18n.mjs` lists what is missing).
- Keep `web/src/remotion/resolve.ts` (`clipPieces`) and `engine/cadre_engine/ai/tools.py` (`pieces`) in sync: they
  compute the same silence cuts on both sides.
- The assistant's tool names and argument names are a stable API used by saved conversations; add new ones rather
  than renaming existing ones.
- Match the surrounding code style. Comments and docs are in English.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
