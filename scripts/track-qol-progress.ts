#!/usr/bin/env bun
/**
 * QoL Progress Tracker - runs every minute to check task status
 */

import { listTasks, getTaskStats } from "../src/db/queries.js";
import { getAdapter } from "../src/db/client.js";

function log(msg: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
}

async function trackProgress() {
  try {
    // Get QoL task stats
    const tasks = await listTasks();
    const qolTasks = tasks.filter(t => t.title?.includes("QoL:"));
    
    const pending = qolTasks.filter(t => t.status === "pending").length;
    const inProgress = qolTasks.filter(t => t.status === "in_progress").length;
    const completed = qolTasks.filter(t => t.status === "completed").length;
    const total = qolTasks.length;
    
    log(`QoL Tasks - Total: ${total}, Pending: ${pending}, In Progress: ${inProgress}, Completed: ${completed}`);
    
    // If all done, we could self-destruct the cron job here
    if (pending === 0 && inProgress === 0 && total > 0) {
      log("🎉 All QoL tasks completed!");
      // Could delete the cron job here
    }
    
    // Show current in-progress tasks
    const active = qolTasks.filter(t => t.status === "in_progress");
    if (active.length > 0) {
      log(`Currently working on: ${active.map(t => t.title).join(", ")}`);
    }
    
  } catch (err) {
    log(`Error tracking progress: ${err}`);
  }
}

// Run immediately
trackProgress();

// Also export for cron
export { trackProgress };
