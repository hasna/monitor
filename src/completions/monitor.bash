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

  local subcommands="status health machines add doctor ps mcp-health mcp-status mcp-restart exec kill alerts apps compare-apps service temperature ports loop-check tailscale containers report cron search migrate retention integrations serve mcp sync completions help"

  case "$prev" in
    monitor)
      COMPREPLY=($(compgen -W "$subcommands" -- "$cur"))
      return
      ;;

    status)
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

    health)
      COMPREPLY=($(compgen -W "-j --json --probe-services" -- "$cur"))
      return
      ;;

    machines)
      COMPREPLY=($(compgen -W "-n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    doctor)
      local machines
      machines=$(_monitor_machine_ids)
      local opts="-n --limit --cursor -v --verbose -j --json"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      else
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      return
      ;;

    alerts)
      local machines
      machines=$(_monitor_machine_ids)
      local opts="-a --all -n --limit --cursor -v --verbose -j --json"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      else
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      return
      ;;

    report)
      COMPREPLY=($(compgen -W "-p --period -s --send --schedule --allow-live-cloud-polling -j --json" -- "$cur"))
      return
      ;;

    apps)
      COMPREPLY=($(compgen -W "-a --all -c --compare -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    compare-apps)
      COMPREPLY=($(compgen -W "-n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    service)
      COMPREPLY=($(compgen -W "-m --machine -n --limit --cursor -v --verbose -j --json list start stop restart" -- "$cur"))
      return
      ;;

    temperature)
      COMPREPLY=($(compgen -W "-a --all -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    ports)
      COMPREPLY=($(compgen -W "-a --all -p --protocol -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    tailscale)
      COMPREPLY=($(compgen -W "-a --all -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    mcp-health|mcp-status)
      COMPREPLY=($(compgen -W "-a --all -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    mcp-restart)
      COMPREPLY=($(compgen -W "-m --machine -j --json" -- "$cur"))
      return
      ;;

    exec)
      COMPREPLY=($(compgen -W "-m --machine -a --all --no-enter --timeout-ms -j --json" -- "$cur"))
      return
      ;;

    containers)
      COMPREPLY=($(compgen -W "-a --all -l --logs -t --tail -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      return
      ;;

    ps)
      local opts="-n --limit --cursor -v --verbose -s --sort -f --filter -j --json"
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "$opts" -- "$cur"))
      else
        local machines
        machines=$(_monitor_machine_ids)
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      return
      ;;

    search)
      COMPREPLY=($(compgen -W "-t --tables -n --limit --cursor -v --verbose -j --json" -- "$cur"))
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
      COMPREPLY=($(compgen -W "-p --port -H --host" -- "$cur"))
      return
      ;;

    retention)
      COMPREPLY=($(compgen -W "--full-res-hours --hourly-days --daily-days --dry-run" -- "$cur"))
      return
      ;;

    loop-check)
      COMPREPLY=($(compgen -W "listening-ports workspace-ports process-hygiene quarantine-retention" -- "$cur"))
      return
      ;;

    integrations)
      COMPREPLY=($(compgen -W "list test" -- "$cur"))
      return
      ;;

    sync)
      COMPREPLY=($(compgen -W "push pull status" -- "$cur"))
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
      status|health|machines|add|doctor|ps|mcp-health|mcp-status|mcp-restart|exec|kill|alerts|apps|compare-apps|service|temperature|ports|loop-check|tailscale|containers|report|cron|search|migrate|retention|integrations|serve|mcp|sync|completions)
        subcommand="${words[$i]}"
        break
        ;;
    esac
  done

  case "$subcommand" in
    containers)
      local prev_in_containers="${words[$((cword - 1))]}"
      case "$prev_in_containers" in
        --tail|-t)
          COMPREPLY=()
          ;;
        *)
          if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "-a --all -l --logs -t --tail -n --limit --cursor -v --verbose -j --json" -- "$cur"))
          else
            local machines
            machines=$(_monitor_machine_ids)
            COMPREPLY=($(compgen -W "$machines" -- "$cur"))
          fi
          ;;
      esac
      ;;
    ports)
      local prev_in_ports="${words[$((cword - 1))]}"
      case "$prev_in_ports" in
        --protocol|-p)
          COMPREPLY=($(compgen -W "tcp udp" -- "$cur"))
          ;;
        *)
          if [[ "$cur" == -* ]]; then
            COMPREPLY=($(compgen -W "-a --all -p --protocol -n --limit --cursor -v --verbose -j --json" -- "$cur"))
          else
            local machines
            machines=$(_monitor_machine_ids)
            COMPREPLY=($(compgen -W "$machines" -- "$cur"))
          fi
          ;;
      esac
      ;;
    tailscale)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-a --all -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      else
        local machines
        machines=$(_monitor_machine_ids)
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      ;;
    apps)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-a --all -c --compare -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      else
        local machines
        machines=$(_monitor_machine_ids)
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      ;;
    service)
      local prev_in_service="${words[$((cword - 1))]}"
      case "$prev_in_service" in
        --machine|-m)
          local machines
          machines=$(_monitor_machine_ids)
          COMPREPLY=($(compgen -W "$machines" -- "$cur"))
          ;;
        list|start|stop|restart)
          COMPREPLY=()
          ;;
        *)
          COMPREPLY=($(compgen -W "-m --machine -n --limit --cursor -v --verbose -j --json list start stop restart" -- "$cur"))
          ;;
      esac
      ;;
    temperature)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-a --all -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      else
        local machines
        machines=$(_monitor_machine_ids)
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      ;;
    mcp-health|mcp-status)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-a --all -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      else
        local machines
        machines=$(_monitor_machine_ids)
        COMPREPLY=($(compgen -W "$machines" -- "$cur"))
      fi
      ;;
    mcp-restart)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=($(compgen -W "-m --machine -j --json" -- "$cur"))
      fi
      ;;
    report)
      local prev_in_report="${words[$((cword - 1))]}"
      case "$prev_in_report" in
        --period|-p|--schedule)
          COMPREPLY=($(compgen -W "daily weekly" -- "$cur"))
          ;;
        *)
          COMPREPLY=($(compgen -W "-p --period -s --send --schedule --allow-live-cloud-polling -j --json" -- "$cur"))
          ;;
      esac
      ;;
    cron)
      local prev_in_cron="${words[$((cword - 1))]}"
      case "$prev_in_cron" in
        list)
          COMPREPLY=($(compgen -W "-m --machine -n --limit --cursor -v --verbose -j --json" -- "$cur"))
          ;;
        add)
          COMPREPLY=($(compgen -W "-m --machine" -- "$cur"))
          ;;
        *)
          COMPREPLY=($(compgen -W "list add run" -- "$cur"))
          ;;
      esac
      ;;
    loop-check)
      COMPREPLY=($(compgen -W "listening-ports workspace-ports process-hygiene quarantine-retention -j --json --evidence-dir --no-evidence --max-evidence-items --max-task-seeds --upsert-tasks --todos-project --task-list --todos-bin --max-task-actions --allow --workspace --machine --max-repos --max-files --high-mem-mb --stuck-hours --root --max-gb --target-gb --apply" -- "$cur"))
      ;;
    integrations)
      COMPREPLY=($(compgen -W "list test -j --json todos conversations mementos emails" -- "$cur"))
      ;;
    sync)
      COMPREPLY=($(compgen -W "push pull status -t --tables" -- "$cur"))
      ;;
    search)
      COMPREPLY=($(compgen -W "-t --tables -n --limit --cursor -v --verbose -j --json" -- "$cur"))
      ;;
    completions)
      COMPREPLY=($(compgen -W "zsh bash install -s --shell" -- "$cur"))
      ;;
  esac
}

complete -F _monitor monitor
