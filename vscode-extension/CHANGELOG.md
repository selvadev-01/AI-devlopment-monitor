# Changelog

## 0.2.6
- First release on the VS Code Marketplace and Open VSX, as `selvadev.ai-dev-monitor`. Earlier builds were named `local.ai-dev-monitor`: uninstall that one, so two monitors don't compete for the same port.
- The extension can install the Claude Code hooks itself:
  - It asks once when the hooks are missing, or when they point to another port.
  - You can also run **Install Claude Code Hooks** and **Remove Claude Code Hooks** from the Command Palette.
- MIT license.

## 0.2.5
- `adm doctor` checks the setup from Claude Code to the monitor: hooks, the running monitor, what the latest session sent, token reading, subagent matching and alerts.

## 0.2.4
- Galaxy: zoomed-in views show more detail.
- Neural: cell bodies have a cell-wall pattern and a nucleus, dendrites branch and end in bulbs, and blurred cells give the background depth.
- Favicon.

## 0.2.3
- Tokens and cost, read from Claude Code's transcripts and shown three ways:
  - a live chip in the top bar
  - the cost of each subagent
  - a section in the session summary

## 0.2.2
- Session summary card after long turns, and from the Summary button at any time.

## 0.2.1
- Needs-you alerts: a desktop notification, a sound and a banner when Claude asks for permission, asks a question or finishes a long turn.

## 0.2.0
- Claude Code in a terminal: an auto-start hook, and the `adm` command.
- Focus mode and grouping for big projects.
- Galaxy theme with a photographic disc.
- File search, and opening files in the editor from the map.
- Exact matching of subagents to their launches.
