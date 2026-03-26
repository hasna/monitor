import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ProcessInfo } from "@/hooks/useMetrics";

interface ProcessTableProps {
  processes: ProcessInfo[];
  onKill?: (pid: number) => void;
}

type SortKey = "cpu" | "mem" | "pid" | "name";
type FilterType = "all" | "zombies" | "orphans";

export function ProcessTable({ processes, onKill }: ProcessTableProps) {
  const [sortBy, setSortBy] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<FilterType>("all");

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  const zombieCount = processes.filter((p) => p.isZombie).length;
  const orphanCount = processes.filter((p) => p.isOrphan).length;

  const filtered = processes
    .filter((p) => {
      if (filterType === "zombies") return p.isZombie;
      if (filterType === "orphans") return p.isOrphan;
      return true;
    })
    .filter(
      (p) =>
        search === "" ||
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        String(p.pid).includes(search) ||
        (p.user ?? "").toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      let diff = 0;
      switch (sortBy) {
        case "cpu":
          diff = b.cpuPercent - a.cpuPercent;
          break;
        case "mem":
          diff = b.memMb - a.memMb;
          break;
        case "pid":
          diff = a.pid - b.pid;
          break;
        case "name":
          diff = a.name.localeCompare(b.name);
          break;
      }
      return sortDir === "asc" ? -diff : diff;
    })
    .slice(0, 100);

  const SortBtn = ({ col, label }: { col: SortKey; label: string }) => (
    <button
      className="flex items-center gap-1 hover:text-zinc-200 transition-colors"
      onClick={() => handleSort(col)}
    >
      {label}
      {sortBy === col && (
        <span className="text-zinc-500">{sortDir === "asc" ? "↑" : "↓"}</span>
      )}
    </button>
  );

  const FilterBtn = ({ type, label }: { type: FilterType; label: string }) => (
    <button
      onClick={() => setFilterType(type)}
      className={`text-xs px-2 py-0.5 rounded transition-colors ${
        filterType === type
          ? "bg-zinc-700 text-zinc-200"
          : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>Processes</CardTitle>
            <span className="text-xs text-zinc-600">{processes.length} total</span>
          </div>
          <div className="flex items-center gap-1.5">
            {zombieCount > 0 && (
              <Badge variant="warning">
                {zombieCount} zombie{zombieCount > 1 ? "s" : ""}
              </Badge>
            )}
            {orphanCount > 0 && (
              <Badge variant="outline">
                {orphanCount} orphan{orphanCount > 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        </div>

        {/* Search + filter row */}
        <div className="flex items-center gap-2 mt-2">
          <input
            type="text"
            placeholder="Search by name, PID, or user..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
          />
          <div className="flex items-center gap-1 bg-zinc-800/50 border border-zinc-800 rounded px-1 py-0.5">
            <FilterBtn type="all" label="All" />
            <FilterBtn type="zombies" label="Zombies" />
            <FilterBtn type="orphans" label="Orphans" />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <ScrollArea className="h-80">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">
                  <SortBtn col="pid" label="PID" />
                </TableHead>
                <TableHead>
                  <SortBtn col="name" label="Name" />
                </TableHead>
                <TableHead className="w-20 hidden sm:table-cell">User</TableHead>
                <TableHead className="w-20">
                  <SortBtn col="cpu" label="CPU%" />
                </TableHead>
                <TableHead className="w-20">
                  <SortBtn col="mem" label="Mem MB" />
                </TableHead>
                <TableHead className="w-16 hidden sm:table-cell">Status</TableHead>
                <TableHead className="w-16">Tags</TableHead>
                {onKill && <TableHead className="w-16" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((proc) => (
                <TableRow
                  key={proc.pid}
                  className={proc.isZombie ? "opacity-50" : ""}
                >
                  <TableCell className="font-mono text-xs text-zinc-500">
                    {proc.pid}
                  </TableCell>
                  <TableCell className="font-mono text-xs max-w-[180px] truncate">
                    {proc.name}
                  </TableCell>
                  <TableCell className="text-xs text-zinc-500 hidden sm:table-cell">
                    {proc.user ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <span
                      className={
                        proc.cpuPercent >= 80
                          ? "text-red-400"
                          : proc.cpuPercent >= 50
                            ? "text-yellow-400"
                            : "text-zinc-300"
                      }
                    >
                      {proc.cpuPercent.toFixed(1)}%
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-zinc-300">
                    {proc.memMb >= 1024
                      ? `${(proc.memMb / 1024).toFixed(1)} GB`
                      : `${proc.memMb.toFixed(0)} MB`}
                  </TableCell>
                  <TableCell className="text-xs text-zinc-500 font-mono hidden sm:table-cell">
                    {proc.state}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {proc.isZombie && (
                        <Badge
                          variant="warning"
                          className="text-[10px] px-1.5 py-0"
                        >
                          zombie
                        </Badge>
                      )}
                      {proc.isOrphan && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0"
                        >
                          orphan
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  {onKill && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-red-500 hover:text-red-400 hover:bg-red-500/10"
                        onClick={() => onKill(proc.pid)}
                      >
                        Kill
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={onKill ? 8 : 7}
                    className="text-center text-zinc-600 py-8 text-sm"
                  >
                    No processes match the filter
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
