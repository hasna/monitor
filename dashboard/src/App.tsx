import { useState } from "react";
import Dashboard from "./pages/Dashboard.tsx";
import { MachineSwitcher } from "./components/MachineSwitcher.tsx";

export interface Machine {
  id: string;
  label: string;
  type: "local" | "ssh" | "ec2";
}

export default function App() {
  const [activeMachineId, setActiveMachineId] = useState<string>("local");

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between gap-4">
        {/* Left: logo */}
        <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
          <div className="w-6 h-6 rounded bg-green-500/20 border border-green-500/30 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-green-500" />
          </div>
          <span className="font-mono text-sm font-semibold text-zinc-200 tracking-widest uppercase select-none">
            open-monitor
          </span>
        </div>

        {/* Center: machine switcher */}
        <div className="flex-1 flex justify-center">
          <MachineSwitcher value={activeMachineId} onChange={setActiveMachineId} />
        </div>

        {/* Right: live indicator */}
        <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          <span className="text-xs text-zinc-500 font-mono hidden sm:block">live</span>
        </div>
      </header>

      <main className="p-6">
        <Dashboard
          machineId={activeMachineId}
          onMachineChange={setActiveMachineId}
        />
      </main>
    </div>
  );
}
