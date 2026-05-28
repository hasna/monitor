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
    'apps:Show installed apps or compare them across machines'
    'compare-apps:Compare installed apps across all configured machines'
    'service:List or control system services and detected dev servers'
    'containers:Show container status/resources or logs'
    'ports:Show listening TCP and UDP ports'
    'tailscale:Show Tailscale peer status and latency'
    'temperature:Show CPU/GPU thermals, fan speeds, and alerts'
    'mcp-health:Inspect Claude MCP server status and dead tmux panes'
    'mcp-status:Show MCP server health with matched process details'
    'mcp-restart:Restart a matched MCP process and re-check health'
    'report:Build or schedule fleet health reports'
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
        apps)
          _arguments \
            '(-a --all)'{-a,--all}'[Inspect all configured machines]' \
            '(-c --compare)'{-c,--compare}'[Compare installed apps across machines]' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        compare-apps)
          _arguments \
            '(-j --json)'{-j,--json}'[Output raw JSON]'
          ;;
        service)
          _arguments \
            '(-m --machine)'{-m,--machine}'[Machine ID]:machine-id:_monitor_machine_ids' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1:action:(list start stop restart)' \
            '2::service-name:'
          ;;
        temperature)
          _arguments \
            '(-a --all)'{-a,--all}'[Inspect all configured machines]' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        containers)
          _arguments \
            '(-a --all)'{-a,--all}'[Inspect all configured machines]' \
            '(-l --logs)'{-l,--logs}'[Fetch logs for a specific container]:container:' \
            '(-t --tail)'{-t,--tail}'[Number of log lines to fetch]:lines:' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        ports)
          _arguments \
            '(-a --all)'{-a,--all}'[Scan all configured machines]' \
            '(-p --protocol)'{-p,--protocol}'[Filter by protocol]:protocol:(tcp udp)' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        tailscale)
          _arguments \
            '(-a --all)'{-a,--all}'[Inspect all configured machines]' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        mcp-health|mcp-status)
          _arguments \
            '(-a --all)'{-a,--all}'[Inspect all configured machines]' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1::machine-id:_monitor_machine_ids'
          ;;
        mcp-restart)
          _arguments \
            '(-m --machine)'{-m,--machine}'[Machine ID]:machine-id:_monitor_machine_ids' \
            '(-j --json)'{-j,--json}'[Output raw JSON]' \
            '1:name:'
          ;;
        report)
          _arguments \
            '(-p --period)'{-p,--period}'[Report window]:period:(daily weekly)' \
            '(-s --send)'{-s,--send}'[Send via configured conversations/emails integrations]' \
            '--schedule[Create or update a scheduled report job]:period:(daily weekly)' \
            '(-j --json)'{-j,--json}'[Output raw JSON]'
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
