#!/usr/bin/env bun
import { startApiServer } from "../src/api/server.js";

const port = parseInt(process.env["PORT"] ?? "3847", 10);
startApiServer({ port });
