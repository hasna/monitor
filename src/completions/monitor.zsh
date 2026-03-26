#compdef monitor
# zsh completion for @hasna/monitor CLI
# Install: source this file in ~/.zshrc or run `monitor completions install`

_monitor() {
  local context state line
  typeset -A opt_args

  local -a subcommands
  subcommands=(
    'status:Show current system snapshot (CPU, memory, disk, GPU)'
    'machines:List all configured machines'
    'add:Add a machine to monitor'
    'doctor:Run health checks and show colored report'
    'ps:Show process table'
    'kill:Kill a process by PID'
    'alerts:List alerts for a machine'
    'cron:Manage cron jobs'
    'migrate:Migrate config from legacy locations'
    'serve:Start the REST API and web server'
    'mcp:Start the MCP server (stdio transport)'
    'completions:Generate shell completion scripts'
    'help:Display help for a command'
  )

  _arguments -C \
    '(-h --help)'{-h,--help}'[Show help]' \
    '(-V --version)'{-V,--version}'[Show version]' \
    '1: :->subcmd' \
    '*:: :->args'

  case $state in
    subcmd)
      _describe 'monitor commands' subcommands
      ;;
    args)
      case $words[1] in
        status)
          _arguments \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        machines)
          _arguments \
            '(-j --json)'{-j,--json}'[Output raw JSON]'
          ;;
        add)
          _arguments \
            '--type[Machine type]:type:(local ssh ec2)' \
            '--host[SSH hostname or IP]:host:_hosts' \
            '--port[SSH port]:port:' \
            '--key[SSH private key path]:key:_files' \
            '--aws-region[AWS region]:region:' \
            '--aws-instance-id[EC2 instance ID]:id:' \
            '1:machine-name:'
          ;;
        doctor)
          _arguments \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        ps)
          _arguments \
            '(-n --limit)'{-n,--limit}'[Number of processes to show]:n:' \
            '(-s --sort)'{-s,--sort}'[Sort by]:sort:(cpu mem)' \
            '(-f --filter)'{-f,--filter}'[Filter]:filter:(all zombies orphans high_mem)' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        kill)
          _arguments \
            '(-m --machine)'{-m,--machine}'[Machine ID]:machine-id:_monitor_machine_ids' \
            '(-f --force)'[Use SIGKILL instead of SIGTERM] \
            '--dry-run[Print what would happen without executing]' \
            '1:pid:'
          ;;
        alerts)
          _arguments \
            '(-a --all)'{-a,--all}'[Show all alerts including resolved ones]' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        cron)
          local -a cron_subcommands
          cron_subcommands=(
            'list:List all cron jobs'
            'add:Add a new cron job'
            'run:Run a cron job immediately'
          )
          _arguments -C \
            '1: :->cron_subcmd' \
            '*:: :->cron_args'
          case $state in
            cron_subcmd)
              _describe 'cron commands' cron_subcommands
              ;;
            cron_args)
              case $words[1] in
                list)
                  _arguments \
                    '(-m --machine)'{-m,--machine}'[Filter by machine ID]:machine-id:_monitor_machine_ids' \
                    '(-j --json)'{-j,--json}'[Output raw JSON]'
                  ;;
                add)
                  _arguments \
                    '(-m --machine)'{-m,--machine}'[Machine ID]:machine-id:_monitor_machine_ids' \
                    '1:name:' \
                    '2:schedule:' \
                    '3:command:'
                  ;;
                run)
                  _arguments '1:job-id:'
                  ;;
              esac
              ;;
          esac
          ;;
        completions)
          local -a completion_subcommands
          completion_subcommands=(
            'zsh:Generate zsh completion script'
            'bash:Generate bash completion script'
            'install:Install completions for your shell'
          )
          _arguments -C \
            '1: :->comp_subcmd'
          case $state in
            comp_subcmd)
              _describe 'completions commands' completion_subcommands
              ;;
          esac
          ;;
        serve)
          _arguments \
            '(-p --port)'{-p,--port}'[API port]:port:'
          ;;
      esac
      ;;
  esac
}

_monitor_machine_ids() {
  local -a machine_ids
  # Try to get machine IDs from the CLI; fall back to common defaults
  if command -v monitor &>/dev/null; then
    machine_ids=($(monitor machines --json 2>/dev/null | grep '"id"' | sed 's/.*"id": *"\([^"]*\)".*/\1/' 2>/dev/null))
  fi
  if [[ ${#machine_ids[@]} -eq 0 ]]; then
    machine_ids=(local)
  fi
  _values 'machine id' $machine_ids
}

_monitor "$@"
