import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Monitor, Server, Cloud } from "lucide-react";
import { useMachines } from "@/hooks/useMetrics";

interface MachineSwitcherProps {
  value: string;
  onChange: (id: string) => void;
}

function MachineTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "local":
      return <Monitor className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
    case "ssh":
      return <Server className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
    case "ec2":
      return <Cloud className="w-3.5 h-3.5 text-orange-400 shrink-0" />;
    default:
      return <Server className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  }
}

function TypeBadge({ type }: { type: string }) {
  switch (type) {
    case "local":
      return (
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-1">
          local
        </Badge>
      );
    case "ssh":
      return (
        <Badge className="text-[10px] px-1.5 py-0 ml-1 bg-blue-500/10 text-blue-400 border-blue-500/20">
          ssh
        </Badge>
      );
    case "ec2":
      return (
        <Badge className="text-[10px] px-1.5 py-0 ml-1 bg-orange-500/10 text-orange-400 border-orange-500/20">
          ec2
        </Badge>
      );
    default:
      return null;
  }
}

function StatusDot({ status }: { status?: string }) {
  if (status === "online") {
    return <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />;
  }
  if (status === "offline") {
    return <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />;
  }
  return <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />;
}

export function MachineSwitcher({ value, onChange }: MachineSwitcherProps) {
  const { machines, loading } = useMachines();

  if (loading) {
    return <div className="w-52 h-9 bg-zinc-800 rounded-md animate-pulse" />;
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-52">
        <SelectValue placeholder="Select machine..." />
      </SelectTrigger>
      <SelectContent>
        {machines.map((machine) => (
          <SelectItem key={machine.id} value={machine.id}>
            <div className="flex items-center gap-2">
              <StatusDot status={machine.status} />
              <MachineTypeIcon type={machine.type} />
              <span className="truncate">{machine.label}</span>
              <TypeBadge type={machine.type} />
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
