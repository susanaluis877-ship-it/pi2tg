# Changelog

## Unreleased

- Add `telegram_ask` for cancellable single-choice or reply-to text clarification, without replacing permission approvals.
- Add `telegram_send_file` for bounded project artifact uploads and PNG/JPEG previews.
- Share outbound flood control with tool requests, propagate delivery failures and cancel queued requests on shutdown.

## [0.1.0]

Initial preview release targeting Pi 1.5.0.

- Control the current Pi TUI session through a private Telegram bot.
- Per-project trusted configuration in `.pi/pi2tg.env`, with local bot instance locking.
- Text task queue, steering at turn boundaries, stop and deferred reload.
- Photo and image document input with size limits and cancellation.
- Model selection, scoped command menus and authenticated single-use buttons.
- Dynamic execution panel with throttled edits and bounded recent activity.
- Markdown rendering, message splitting, network retries and rate limiting.

Known limitations: no durable task recovery, no album grouping, no remote permission approvals, and no cross-machine bot lock. Offline updates are intentionally skipped on connection. See README for security boundaries and validation steps.
