import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, Info, XCircle, Bell } from "lucide-react";
import type { Alert } from "@/hooks/useMetrics";

interface AlertsPanelProps {
  alerts: Alert[];
  onResolve?: (alert: Alert, index: number) => void;
}

function SeverityIcon({ severity }: { severity: Alert["severity"] }) {
  switch (severity) {
    case "critical":
      return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
    case "warning":
      return <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />;
    default:
      return <Info className="w-4 h-4 text-blue-400 shrink-0" />;
  }
}

function severityBadgeVariant(severity: Alert["severity"]) {
  switch (severity) {
    case "critical":
      return "destructive" as const;
    case "warning":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

export function AlertsPanel({ alerts, onResolve }: AlertsPanelProps) {
  // local dismiss state if no onResolve callback
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const visible = alerts.filter((_, i) => !dismissed.has(i));
  const criticals = visible.filter((a) => a.severity === "critical").length;
  const warnings = visible.filter((a) => a.severity === "warning").length;

  const handleResolve = (alert: Alert, originalIdx: number) => {
    if (onResolve) {
      onResolve(alert, originalIdx);
    } else {
      setDismissed((prev) => new Set(prev).add(originalIdx));
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-zinc-400" />
            <CardTitle>Alerts</CardTitle>
          </div>
          <div className="flex gap-1.5">
            {criticals > 0 && (
              <Badge variant="destructive">{criticals} critical</Badge>
            )}
            {warnings > 0 && (
              <Badge variant="warning">{warnings} warning</Badge>
            )}
            {visible.length === 0 && (
              <Badge variant="success">All clear</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <div className="flex items-center justify-center h-28 text-zinc-600 text-sm">
            No active alerts
          </div>
        ) : (
          <ScrollArea className="h-64">
            <div className="px-4 pb-4 space-y-2">
              {alerts.map((alert, i) => {
                if (dismissed.has(i)) return null;
                return (
                  <div
                    key={i}
                    className={`flex items-start gap-3 p-3 rounded-md border ${
                      alert.severity === "critical"
                        ? "bg-red-500/5 border-red-500/15"
                        : alert.severity === "warning"
                          ? "bg-yellow-500/5 border-yellow-500/15"
                          : "bg-blue-500/5 border-blue-500/15"
                    }`}
                  >
                    <SeverityIcon severity={alert.severity} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge
                          variant={severityBadgeVariant(alert.severity)}
                          className="text-[10px] px-1.5 py-0 capitalize"
                        >
                          {alert.category}
                        </Badge>
                        <Badge
                          variant={severityBadgeVariant(alert.severity)}
                          className="text-[10px] px-1.5 py-0 capitalize"
                        >
                          {alert.severity}
                        </Badge>
                      </div>
                      <p className="text-xs text-zinc-300 mt-0.5">{alert.message}</p>
                      <p className="text-[10px] text-zinc-600 mt-0.5">
                        {new Date(alert.ts).toLocaleTimeString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-zinc-500 hover:text-zinc-200 shrink-0"
                      onClick={() => handleResolve(alert, i)}
                    >
                      Resolve
                    </Button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
