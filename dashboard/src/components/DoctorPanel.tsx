import { CheckCircle2, AlertTriangle, XCircle, Stethoscope, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDoctor, type DoctorCheck } from "@/hooks/useMetrics";

interface DoctorPanelProps {
  machineId: string;
}

function StatusIcon({ status }: { status: DoctorCheck["status"] }) {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />;
    case "warn":
      return <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />;
    case "critical":
      return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
  }
}

function statusBadgeVariant(status: DoctorCheck["status"]) {
  switch (status) {
    case "ok":
      return "success" as const;
    case "warn":
      return "warning" as const;
    case "critical":
      return "destructive" as const;
  }
}

export function DoctorPanel({ machineId }: DoctorPanelProps) {
  const { result, loading, error, runDoctor } = useDoctor(machineId);

  const okCount = result?.checks.filter((c) => c.status === "ok").length ?? 0;
  const warnCount = result?.checks.filter((c) => c.status === "warn").length ?? 0;
  const critCount = result?.checks.filter((c) => c.status === "critical").length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Stethoscope className="w-4 h-4 text-zinc-400" />
            <CardTitle>Doctor</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {result && (
              <div className="flex gap-1">
                {critCount > 0 && (
                  <Badge variant="destructive">{critCount} critical</Badge>
                )}
                {warnCount > 0 && (
                  <Badge variant="warning">{warnCount} warn</Badge>
                )}
                {critCount === 0 && warnCount === 0 && okCount > 0 && (
                  <Badge variant="success">All ok</Badge>
                )}
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-200"
              onClick={runDoctor}
              disabled={loading}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
              Run Doctor
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {!result && !loading && !error && (
          <div className="flex flex-col items-center justify-center h-28 text-zinc-600 text-sm gap-2">
            <Stethoscope className="w-8 h-8 text-zinc-800" />
            <span>Click "Run Doctor" to diagnose this machine</span>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-28 text-zinc-500 text-sm gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Running diagnostics...
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center justify-center h-28 text-red-400 text-sm px-4 text-center">
            {error}
          </div>
        )}

        {result && !loading && (
          <ScrollArea className="h-64">
            <div className="px-4 pb-4 space-y-2">
              {result.checks.map((check, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-3 p-3 rounded-md border ${
                    check.status === "critical"
                      ? "bg-red-500/5 border-red-500/15"
                      : check.status === "warn"
                        ? "bg-yellow-500/5 border-yellow-500/15"
                        : "bg-zinc-800/30 border-zinc-800"
                  }`}
                >
                  <StatusIcon status={check.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium text-zinc-300">{check.name}</span>
                      <Badge
                        variant={statusBadgeVariant(check.status)}
                        className="text-[10px] px-1.5 py-0 capitalize"
                      >
                        {check.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-zinc-500">{check.message}</p>
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-zinc-700 font-mono text-right pt-1">
                ran @ {new Date(result.ts).toLocaleTimeString()}
              </p>
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
