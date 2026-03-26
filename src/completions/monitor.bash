#!/usr/bin/env bash
# bash completion for @hasna/monitor CLI
# Install: source this file in ~/.bashrc or run `monitor completions install`

_monitor_machine_ids() {
  local machine_ids
  if command -v monitor &>/dev/null; then
    machine_ids=$(monitor machines --json 2>/dev/null | grep '"id"' | sed 's/.*"id": *"\([^"]*\)".*/\1/' 2>/dev/null)
  fi
  if [[ -z "$machine_ids" ]]; then
    machine_ids="local"
  fi
  echo "$machine_ids"
}

_monitor() {
  local cur prev words cword
  _init_completion || return

  local subcommands="status machines add doctor ps kill alerts cron migrate serve mcp completions help"

  case "$prev" in
    monitor)
      COMPREPLY=($(compgen -W "$subcommands" -- "$cur"))
      return
      ;;

    status|doctor|alerts)
      local machines
      machines=$(_monitor_machine_ids)
      local opts="-j --json"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      else
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      return
      ;;

    ps)
      local opts="-n --limit -s --sort -f --filter -j --json"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      else
        local machines
        machines=$(_monitor_machine_ids)
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      return
      ;;

    --sort|-s)
      COMPREPLY=($(compgen -W "cpu mem" -- "$cur"))
      return
      ;;

    --filter|-f)
      COMPREPLY=($(compgen -W "all zombies orphans high_mem" -- "$cur"))
      return
      ;;

    --machine|-m)
      local machines
      machines=$(_monitor_machine_ids)
      COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      return
      ;;

    kill)
      local opts="-m --machine -f --force --dry-run"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      fi
      return
      ;;

    add)
      local opts="--type --host --port --key --aws-region --aws-instance-id"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      fi
      return
      ;;

    --type)
      COMPREPLY=($(compgen -W "local ssh ec2" -- "$cur"))
      return
      ;;

    --key)
      COMPREPLY=($(compgen -f -- "$cur"))
      return
      ;;

    serve)
      COMPREPLY=($(compgen -W "-p --port" -- "$cur"))
      return
      ;;

    cron)
      COMPREPLY=($(compgen -W "list add run" -- "$cur"))
      return
      ;;

    completions)
      COMPREPLY=($(compgen -W "zsh bash install" -- "$cur"))
      return
      ;;
  esac

  # Multi-word completion — find the subcommand
  local i subcommand=""
  for (( i=1; i < cword; i++ )); do
    case "${words[$i]}" in
      status|machines|add|doctor|ps|kill|alerts|cron|migrate|serve|mcp|completions)
        subcommand="${words[$i]}"
        break
        ;;
    esac
  done

  case "$subcommand" in
    cron)
      local prev_in_cron="${words[$((cword - 1))]}"
      case "$prev_in_cron" in
        list)
          COMPREPLY=($(compgen -W "-m --machine -j --json" -- "$cur"))
          ;;
        add)
          COMPREPLY=($(compgen -W "-m --machine" -- "$cur"))
          ;;
        *)
          COMPREPLY=($(compgen -W "list add run" -- "$cur"))
          ;;
      esac
      ;;
    completions)
      COMPREPLY=($(compgen -W "zsh bash install" -- "$cur"))
      ;;
  esac
}

complete -F _monitor monitor
