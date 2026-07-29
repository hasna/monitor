import { describe, expect, it } from "bun:test";
import {
  sanitizeCmd,
  sanitizeMachineConfig,
  sanitizeMachineConfigs,
  sanitizeMachineRow,
  sanitizeMachineRows,
  sanitizeProcessRow,
  sanitizeSearchResult,
  sanitizeSystemSnapshot,
} from "./security.js";

describe("sanitizeCmd", () => {
  it("redacts common secret env assignments and long options", () => {
    const command = [
      "OPENAI_API_KEY=sk-live-123",
      "AWS_SESSION_TOKEN=aws-token-456",
      "DATABASE_URL=postgres://user:pass@db.example.test/monitor",
      "node server.js",
      "--api-key sk-cli-789",
      "--client-secret='client secret value'",
      "--password=\"quoted password value\"",
      "--safe value",
    ].join(" ");

    const sanitized = sanitizeCmd(command);

    expect(sanitized).toContain("OPENAI_API_KEY=***");
    expect(sanitized).toContain("AWS_SESSION_TOKEN=***");
    expect(sanitized).toContain("DATABASE_URL=***");
    expect(sanitized).toContain("--api-key ***");
    expect(sanitized).toContain("--client-secret=***");
    expect(sanitized).toContain("--password=***");
    expect(sanitized).toContain("--safe value");
    expect(sanitized).not.toContain("sk-live-123");
    expect(sanitized).not.toContain("aws-token-456");
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("sk-cli-789");
    expect(sanitized).not.toContain("client secret value");
    expect(sanitized).not.toContain("quoted password value");

    expect(sanitizeCmd("node app client.secret=sk.live-123")).toBe("node app client.secret=***");
    expect(sanitizeCmd("node app --api.key=sk-live-123")).toBe("node app --api.key=***");
    expect(sanitizeCmd("node app --access.token eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(
      "node app --access.token ***"
    );
  });

  it("redacts sensitive options after non-sensitive boolean options", () => {
    expect(sanitizeCmd("node app --verbose --api-key sk-after-flag")).toBe(
      "node app --verbose --api-key ***"
    );
    expect(sanitizeCmd("node app --dry-run --password hunter2")).toBe(
      "node app --dry-run --password ***"
    );
  });

  it("redacts credentials embedded in standalone connection URLs", () => {
    const sanitized = sanitizeCmd(
      "psql postgres://monitor:db-secret@db.example.test/monitor && redis-cli -u redis://:redis-secret@localhost:6379/0"
    );

    expect(sanitized).toContain("postgres://***@db.example.test/monitor");
    expect(sanitized).toContain("redis://***@localhost:6379/0");
    expect(sanitized).not.toContain("monitor:db-secret");
    expect(sanitized).not.toContain("redis-secret");
  });

  it("redacts URL userinfo through the last at-sign in the authority", () => {
    expect(sanitizeCmd("psql postgres://user:p@tailsecret@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
  });

  it("does not treat path or query at-signs as URL credentials", () => {
    expect(sanitizeCmd("curl https://example.test/path@notuserinfo")).toBe(
      "curl https://example.test/path@notuserinfo"
    );
    expect(sanitizeCmd("curl http://[2001:db8::1]/path@notuserinfo")).toBe(
      "curl http://[2001:db8::1]/path@notuserinfo"
    );
    expect(sanitizeCmd("psql postgres://user:secret@db.example.test/monitor?owner=a@b.test")).toBe(
      "psql postgres://***@db.example.test/monitor?owner=a@b.test"
    );
    expect(sanitizeCmd("psql postgres://db.example.test:x/monitor?owner=a@b.test")).toBe(
      "psql postgres://db.example.test:x/monitor?owner=a@b.test"
    );
    expect(sanitizeCmd("psql postgres://db.example.test:x/monitor@notcred")).toBe(
      "psql postgres://db.example.test:x/monitor@notcred"
    );
    expect(sanitizeCmd("psql postgres://db.example.test:x/monitor@notcred.example/path")).toBe(
      "psql postgres://db.example.test:x/monitor@notcred.example/path"
    );
    expect(sanitizeCmd("psql postgres://user:secret@db.example.test/database@tenant.example/migrations")).toBe(
      "psql postgres://***@db.example.test/database@tenant.example/migrations"
    );
    expect(sanitizeCmd("psql postgres://user:secret@app/database@tenant.example/migrations")).toBe(
      "psql postgres://***@app/database@tenant.example/migrations"
    );
    expect(sanitizeCmd("mongo mongodb://user:secret@mongo.example.test/db@tenant.example/collection")).toBe(
      "mongo mongodb://***@mongo.example.test/db@tenant.example/collection"
    );
    expect(sanitizeCmd("mongo mongodb://user:secret@cluster/db@tenant.example/collection")).toBe(
      "mongo mongodb://***@cluster/db@tenant.example/collection"
    );
    expect(sanitizeCmd("psql postgresql://user:secret@[2001:db8::1]/db@tenant.example/x")).toBe(
      "psql postgresql://***@[2001:db8::1]/db@tenant.example/x"
    );
    expect(sanitizeCmd("redis redis://:secret@cache.example.test:6379/0@tenant.example/path")).toBe(
      "redis redis://***@cache.example.test:6379/0@tenant.example/path"
    );
    expect(sanitizeCmd("redis redis://:secret@queue/0@tenant.example/path")).toBe(
      "redis redis://***@queue/0@tenant.example/path"
    );
    expect(sanitizeCmd("psql postgres://db.example.test:x/monitor?next=redis://:secret@cache:6379/0")).toBe(
      "psql postgres://db.example.test:x/monitor?next=redis://***@cache:6379/0"
    );
    expect(sanitizeCmd("mongo mongodb://host1:27017,host2:27017/db?replicaSet=a@b")).toBe(
      "mongo mongodb://host1:27017,host2:27017/db?replicaSet=a@b"
    );
    expect(sanitizeCmd("psql postgres://db:x/monitor@cache")).toBe(
      "psql postgres://db:x/monitor@cache"
    );
    expect(sanitizeCmd("psql postgres://app:x/monitor@cache")).toBe(
      "psql postgres://app:x/monitor@cache"
    );
    expect(sanitizeCmd("psql postgres://api:x/monitor@cache")).toBe(
      "psql postgres://api:x/monitor@cache"
    );
    expect(sanitizeCmd("psql postgres://LOCALHOST:x/monitor@cache")).toBe(
      "psql postgres://LOCALHOST:x/monitor@cache"
    );
    expect(sanitizeCmd("psql postgres://app:token/monitor@cache")).toBe(
      "psql postgres://app:token/monitor@cache"
    );
    expect(sanitizeCmd("psql postgres://api:token/monitor@cache")).toBe(
      "psql postgres://api:token/monitor@cache"
    );
    expect(sanitizeCmd("psql postgres://db:token/monitor@cache")).toBe(
      "psql postgres://db:token/monitor@cache"
    );
    expect(sanitizeCmd("echo [https://example.test]@owner")).toBe(
      "echo [https://example.test]@owner"
    );
    expect(sanitizeCmd("echo (https://example.test)@owner")).toBe(
      "echo (https://example.test)@owner"
    );
    expect(sanitizeCmd("echo {https://example.test}@owner")).toBe(
      "echo {https://example.test}@owner"
    );
    expect(sanitizeCmd("echo `https://example.test`@owner")).toBe(
      "echo `https://example.test`@owner"
    );
    expect(sanitizeCmd("echo 'https://example.test'@owner")).toBe(
      "echo 'https://example.test'@owner"
    );
    expect(sanitizeCmd("echo \"https://example.test\"@owner")).toBe(
      "echo \"https://example.test\"@owner"
    );
    expect(sanitizeCmd("echo <https://example.test>@owner")).toBe(
      "echo <https://example.test>@owner"
    );
    expect(sanitizeCmd("echo http://[2001:db8::1]@owner")).toBe(
      "echo http://[2001:db8::1]@owner"
    );
  });

  it("redacts each credentialed URL in same-token URL lists", () => {
    expect(sanitizeCmd("node app urls=postgres://u:p@h/db,postgres://u2:p2@h2/db")).toBe(
      "node app urls=postgres://***@h/db,postgres://***@h2/db"
    );

    const manyUrls = Array.from({ length: 120 }, (_, index) => `postgres://u${index}:p${index}@h${index}`).join(",");
    const sanitized = sanitizeCmd(`node app urls=${manyUrls}`);
    expect(sanitized.match(/postgres:\/\/\*\*\*@/g)).toHaveLength(120);
    expect(sanitized).not.toContain(":p100@");
  });

  it("redacts credentialed nested URLs and shell-adjacent URL values", () => {
    expect(
      sanitizeCmd("curl https://api.example.test/fetch?target=postgres://user:secret@db.example.test/monitor")
    ).toBe("curl https://api.example.test/fetch?target=postgres://***@db.example.test/monitor");
    expect(sanitizeCmd("urls=postgres://u:p@h/db|postgres://u2:p2@h2/db&&redis://:r@cache:6379/0")).toBe(
      "urls=postgres://***@h/db|postgres://***@h2/db&&redis://***@cache:6379/0"
    );
    expect(sanitizeCmd("urls=[postgres://u:p@h][redis://:r@cache]")).toBe(
      "urls=[postgres://***@h][redis://***@cache]"
    );
    expect(sanitizeCmd("urls=(postgres://u:p@h)(redis://:r@cache)")).toBe(
      "urls=(postgres://***@h)(redis://***@cache)"
    );
    expect(sanitizeCmd("urls='postgres://u:p@h''redis://:r@cache'")).toBe(
      "urls='postgres://***@h''redis://***@cache'"
    );
    expect(sanitizeCmd("urls={postgres://u:p@h}{redis://:r@cache}")).toBe(
      "urls={postgres://***@h}{redis://***@cache}"
    );
    expect(sanitizeCmd("urls=`postgres://u:p@h``redis://:r@cache`")).toBe(
      "urls=`postgres://***@h``redis://***@cache`"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h+redis://:r@cache")).toBe(
      "urls=postgres://***@h+redis://***@cache"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h=redis://:r@cache")).toBe(
      "urls=postgres://***@h=redis://***@cache"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h:redis://:r@cache")).toBe(
      "urls=postgres://***@h:redis://***@cache"
    );
    expect(sanitizeCmd('urls=postgres://u:p1@h"redis://:p2@cache"')).toBe(
      'urls=postgres://***@h"redis://***@cache"'
    );
    expect(sanitizeCmd("urls=postgres://u:p1@h<redis://:p2@cache>")).toBe(
      "urls=postgres://***@h<redis://***@cache>"
    );
  });

  it("does not fold separator text with outside at-signs into pathless URL authorities", () => {
    expect(sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&owner=a@b.test")).toBe(
      "curl https://api.example.test/fetch?target=postgres://db.example.test&owner=a@b.test"
    );
    expect(sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&email=a@b.test")).toBe(
      "curl https://api.example.test/fetch?target=postgres://db.example.test&email=a@b.test"
    );
    expect(sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&tenant=a@b.test")).toBe(
      "curl https://api.example.test/fetch?target=postgres://db.example.test&tenant=a@b.test"
    );
    expect(
      sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&owner=a@b.test/path")
    ).toBe("curl https://api.example.test/fetch?target=postgres://db.example.test&owner=a@b.test/path");
    expect(
      sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&email=a@b.test/path")
    ).toBe("curl https://api.example.test/fetch?target=postgres://db.example.test&email=a@b.test/path");
    expect(
      sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&tenant=a@b.test/path")
    ).toBe("curl https://api.example.test/fetch?target=postgres://db.example.test&tenant=a@b.test/path");
    expect(sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&next=a@b.test")).toBe(
      "curl https://api.example.test/fetch?target=postgres://db.example.test&next=a@b.test"
    );
    expect(
      sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&callback=user@example.test")
    ).toBe("curl https://api.example.test/fetch?target=postgres://db.example.test&callback=user@example.test");
    expect(
      sanitizeCmd("curl https://api.example.test/fetch?target=postgres://db.example.test&callback=user@example.test/path")
    ).toBe("curl https://api.example.test/fetch?target=postgres://db.example.test&callback=user@example.test/path");
    expect(sanitizeCmd("curl 'https://api.example.test/fetch?target=postgres://db.example.test&owner=a@b.test'")).toBe(
      "curl 'https://api.example.test/fetch?target=postgres://db.example.test&owner=a@b.test'"
    );
    expect(sanitizeCmd("curl 'https://api.example.test/fetch?target=postgres://db.example.test&next=a@b.test'")).toBe(
      "curl 'https://api.example.test/fetch?target=postgres://db.example.test&next=a@b.test'"
    );
    expect(sanitizeCmd("urls=[postgres://db.example.test&label=a@b]")).toBe(
      "urls=[postgres://db.example.test&label=a@b]"
    );
    expect(sanitizeCmd("urls=[postgres://db.example.test&label=a@b/path]")).toBe(
      "urls=[postgres://db.example.test&label=a@b/path]"
    );
    expect(sanitizeCmd("urls=postgres://db.example.test&owner=a@b")).toBe(
      "urls=postgres://db.example.test&owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://db.example.test:5432&owner=a@b.test")).toBe(
      "urls=postgres://db.example.test:5432&owner=a@b.test"
    );
    expect(sanitizeCmd("urls=postgres://db.example.test:5432&foo=a@b.test/path")).toBe(
      "urls=postgres://db.example.test:5432&foo=a@b.test/path"
    );
    expect(sanitizeCmd("urls=postgres://db&owner=a@b.test")).toBe(
      "urls=postgres://db&owner=a@b.test"
    );
    expect(sanitizeCmd("urls=postgres://db&foo=a@b.test/path")).toBe(
      "urls=postgres://db&foo=a@b.test/path"
    );
    expect(sanitizeCmd("urls=postgres://db.example.test;owner=a@b")).toBe(
      "urls=postgres://db.example.test;owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://db.example.test|owner=a@b")).toBe(
      "urls=postgres://db.example.test|owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://db.example.test,owner=a@b")).toBe(
      "urls=postgres://db.example.test,owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://my_host&owner=a@b")).toBe(
      "urls=postgres://my_host&owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://my~host&owner=a@b")).toBe(
      "urls=postgres://my~host&owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://my%2Dhost&owner=a@b")).toBe(
      "urls=postgres://my%2Dhost&owner=a@b"
    );
    expect(sanitizeCmd("urls=mongodb://host1:27017,host2:27017&owner=a@b.test")).toBe(
      "urls=mongodb://host1:27017,host2:27017&owner=a@b.test"
    );
    expect(sanitizeCmd("urls=mongodb://host1,host2,host3&foo=a@b.test/path")).toBe(
      "urls=mongodb://host1,host2,host3&foo=a@b.test/path"
    );
  });

  it("redacts pathless URL credentials without consuming separator text", () => {
    expect(sanitizeCmd("urls=postgres://u:p@h&owner=a@b")).toBe(
      "urls=postgres://***@h&owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h;owner=a@b")).toBe(
      "urls=postgres://***@h;owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h|owner=a@b")).toBe(
      "urls=postgres://***@h|owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h,owner=a@b")).toBe(
      "urls=postgres://***@h,owner=a@b"
    );
    expect(sanitizeCmd("urls=postgres://u:p@h&next=a@b")).toBe(
      "urls=postgres://***@h&next=a@b"
    );
    expect(sanitizeCmd("curl https://api.example.test/fetch?target=postgres://u:p@h&next=a@b.test")).toBe(
      "curl https://api.example.test/fetch?target=postgres://***@h&next=a@b.test"
    );
    expect(sanitizeCmd("curl https://api.example.test/fetch?target=postgres://u:p@h&next=a@b.test/path")).toBe(
      "curl https://api.example.test/fetch?target=postgres://***@h&next=a@b.test/path"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&redirect=user@example.test")).toBe(
      "target=postgres://***@db.example.test&redirect=user@example.test"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&redirect=user@example.test/path")).toBe(
      "target=postgres://***@db.example.test&redirect=user@example.test/path"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&foo=user@example.test/path")).toBe(
      "target=postgres://***@db.example.test&foo=user@example.test/path"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&next=not_secret@example.test")).toBe(
      "target=postgres://***@db.example.test&next=not_secret@example.test"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&foo=not_secret@example.test/path")).toBe(
      "target=postgres://***@db.example.test&foo=not_secret@example.test/path"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&part=secret")).toBe(
      "target=postgres://***@db.example.test&part=***"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&foo=secret-token")).toBe(
      "target=postgres://***@db.example.test&foo=***"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&foo=not_secret")).toBe(
      "target=postgres://***@db.example.test&foo=not_secret"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&client.secret=sk.live-123")).toBe(
      "target=postgres://***@db.example.test&client.secret=***"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&api.key=sk-live-123")).toBe(
      "target=postgres://***@db.example.test&api.key=***"
    );
    expect(sanitizeCmd("target=postgres://u:p@db.example.test&access.token=eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe(
      "target=postgres://***@db.example.test&access.token=***"
    );
    expect(sanitizeCmd("curl https://example.test/#client.secret=sk.live-123")).toBe(
      "curl https://example.test/#client.secret=***"
    );
    expect(sanitizeCmd("curl https://example.test/#api.key=sk-live-123")).toBe(
      "curl https://example.test/#api.key=***"
    );
  });

  it("keeps URL userinfo punctuation inside the redacted credential", () => {
    expect(sanitizeCmd("psql postgres://user:p,ss@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql postgres://user:p'ss@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd('psql postgres://user:p"ss@db.example.test/monitor')).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd('psql "postgres://user:p\\"ss@db.example.test/monitor"')).toBe(
      'psql "postgres://***@db.example.test/monitor"'
    );
    expect(sanitizeCmd("psql postgres://user:p<ss@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql 'postgres://user:123;abc@db.example.test/monitor'")).toBe(
      "psql 'postgres://***@db.example.test/monitor'"
    );
    expect(sanitizeCmd("psql postgres://u;name@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql postgres://user:p@tail;secret@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql 'postgres://user:p@tail&part=secret@db.example.test/monitor'")).toBe(
      "psql 'postgres://***@db.example.test/monitor'"
    );
    expect(sanitizeCmd("run postgres://user&part=secret@db.example.test")).toBe(
      "run postgres://***@db.example.test"
    );
    expect(sanitizeCmd("run postgres://user&foo=bar@db.example.test")).toBe(
      "run postgres://user&foo=bar@db.example.test"
    );
    expect(sanitizeCmd("run postgres://user.name:123&foo=bar@db.example.test")).toBe(
      "run postgres://user.name:123&foo=bar@db.example.test"
    );
    expect(sanitizeCmd("run 'postgres://sk.live-123&owner=alpha@db.example.test'")).toBe(
      "run 'postgres://***@db.example.test'"
    );
    expect(sanitizeCmd("run postgres://sk.live-123&owner=alpha@db.example.test")).toBe(
      "run postgres://***@db.example.test"
    );
    expect(sanitizeCmd("run 'postgres://sk.live-123&email=alpha@db.example.test'")).toBe(
      "run 'postgres://***@db.example.test'"
    );
    expect(sanitizeCmd("run postgres://user;part=secret@db.example.test")).toBe(
      "run postgres://***@db.example.test"
    );
    expect(sanitizeCmd("run postgres://user;foo=bar@db.example.test")).toBe(
      "run postgres://user;foo=bar@db.example.test"
    );
    expect(sanitizeCmd("run postgres://user,part=secret@db.example.test")).toBe(
      "run postgres://***@db.example.test"
    );
    expect(sanitizeCmd("run postgres://user,foo=bar@db.example.test")).toBe(
      "run postgres://user,foo=bar@db.example.test"
    );
    expect(sanitizeCmd("run postgres://user:123&part=secret@db.example.test")).toBe(
      "run postgres://***@db.example.test"
    );
    expect(sanitizeCmd("run [postgres://user&part=secret@db.example.test]@owner")).toBe(
      "run [postgres://***@db.example.test]@owner"
    );
    expect(sanitizeCmd("psql postgres://user:pass)@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql postgres://user:pass]@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql postgres://user:pass}@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql postgres://user:pass'@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("psql postgres://user:pass`@db.example.test/monitor")).toBe(
      "psql postgres://***@db.example.test/monitor"
    );
    expect(sanitizeCmd("curl https://example.test/path?next=https://user:p,ss@inner.test/path")).toBe(
      "curl https://example.test/path?next=https://***@inner.test/path"
    );
  });
});

describe("sanitizeProcessRow", () => {
  it("redacts cmd fields without mutating the original row", () => {
    const row = {
      pid: 123,
      cmd: "TOKEN=raw-token-value bun run worker",
    };

    const sanitized = sanitizeProcessRow(row);

    expect(sanitized).toEqual({
      pid: 123,
      cmd: "TOKEN=*** bun run worker",
    });
    expect(sanitized).not.toBe(row);
    expect(row.cmd).toContain("raw-token-value");
  });
});

describe("sanitizeSystemSnapshot", () => {
  it("redacts process commands without mutating the original snapshot", () => {
    const snapshot = {
      machineId: "local",
      hostname: "host",
      platform: "linux",
      uptime: 1,
      ts: 1,
      cpu: {
        brand: "cpu",
        cores: 1,
        physicalCores: 1,
        speedGHz: 1,
        usagePercent: 1,
        loadAvg: [0, 0, 0] as [number, number, number],
      },
      mem: {
        totalMb: 1024,
        usedMb: 512,
        freeMb: 512,
        usagePercent: 50,
        swapTotalMb: 0,
        swapUsedMb: 0,
      },
      disks: [],
      gpus: [],
      processes: [
        {
          pid: 123,
          ppid: 1,
          name: "node",
          cmd: "node server.js --verbose --api-key snapshot-secret",
          cpuPercent: 0,
          memMb: 10,
          state: "S",
          isZombie: false,
          isOrphan: false,
        },
      ],
    };

    const sanitized = sanitizeSystemSnapshot(snapshot);

    expect(sanitized.processes[0]?.cmd).toBe("node server.js --verbose --api-key ***");
    expect(snapshot.processes[0]?.cmd).toContain("snapshot-secret");
  });
});

describe("sanitizeSearchResult", () => {
  it("redacts process search row commands and snippets", () => {
    const sanitized = sanitizeSearchResult({
      table: "processes",
      id: 1,
      rank: -1,
      snippet: "node app --api-key >>>search-secret<<<",
      row: {
        id: 1,
        name: "node",
        cmd: "node app --api-key search-secret",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("search-secret");
    expect(sanitized.snippet).toBe("node app --api-key ***");
    expect(sanitized.row["cmd"]).toBe("node app --api-key ***");
  });

  it("redacts ssh_key_path from a machine search row", () => {
    const sanitized = sanitizeSearchResult({
      table: "machines",
      id: "build-node",
      rank: -1,
      snippet: ">>>Build Node<<<",
      row: {
        id: "build-node",
        name: "Build Node",
        type: "ssh",
        host: "build.example.test",
        ssh_key_path: "/home/secretuser/.ssh/id_ed25519_PROD",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("/home/secretuser/.ssh/id_ed25519_PROD");
    expect(sanitized.row["ssh_key_path"]).toBe("***");
    expect(sanitized.row["host"]).toBe("build.example.test");
  });

  it("leaves a keyless machine search row alone", () => {
    const sanitized = sanitizeSearchResult({
      table: "machines",
      id: "local",
      rank: -1,
      snippet: ">>>local<<<",
      row: { id: "local", name: "local", type: "local", ssh_key_path: null },
    });

    expect(sanitized.row["ssh_key_path"]).toBeNull();
  });

  it("passes alert search rows through untouched", () => {
    const row = { id: 7, machine_id: "build-node", message: "disk above 90%" };
    const sanitized = sanitizeSearchResult({
      table: "alerts",
      id: 7,
      rank: -1,
      snippet: "disk above >>>90%<<<",
      row,
    });

    expect(sanitized.row).toEqual(row);
  });
});

describe("sanitizeMachineRow", () => {
  it("redacts ssh_key_path without mutating the original row", () => {
    const row = {
      id: "build-node",
      type: "ssh",
      ssh_key_path: "/home/secretuser/.ssh/id_ed25519_PROD",
    };

    const sanitized = sanitizeMachineRow(row);

    expect(sanitized).toEqual({ id: "build-node", type: "ssh", ssh_key_path: "***" });
    expect(sanitized).not.toBe(row);
    expect(row.ssh_key_path).toBe("/home/secretuser/.ssh/id_ed25519_PROD");
  });

  it("leaves a null key path alone", () => {
    expect(sanitizeMachineRow({ id: "local", ssh_key_path: null }).ssh_key_path).toBeNull();
  });

  it("redacts every row in a list", () => {
    const rows = sanitizeMachineRows([
      { id: "a", ssh_key_path: "/root/.ssh/id_rsa" },
      { id: "b", ssh_key_path: null },
    ]);

    expect(JSON.stringify(rows)).not.toContain("/root/.ssh/id_rsa");
    expect(rows[0]?.ssh_key_path).toBe("***");
    expect(rows[1]?.ssh_key_path).toBeNull();
  });
});

describe("sanitizeMachineConfig", () => {
  it("redacts the SSH key path and password from a config machine", () => {
    const machine = {
      id: "build-node",
      label: "Build Node",
      type: "ssh" as const,
      ssh: {
        host: "build.example.test",
        username: "ops",
        privateKeyPath: "/home/secretuser/.ssh/id_ed25519_PROD",
        password: "P4ssw0rd-LEAK-CANARY",
      },
    };

    const sanitized = sanitizeMachineConfig(machine);

    expect(JSON.stringify(sanitized)).not.toContain("P4ssw0rd-LEAK-CANARY");
    expect(JSON.stringify(sanitized)).not.toContain("/home/secretuser/.ssh/id_ed25519_PROD");
    expect(sanitized.ssh?.privateKeyPath).toBe("***");
    expect(sanitized.ssh?.password).toBe("***");
    expect(sanitized.ssh?.host).toBe("build.example.test");
    expect(sanitized.ssh?.username).toBe("ops");
    expect(machine.ssh.password).toBe("P4ssw0rd-LEAK-CANARY");
  });

  it("does not invent SSH fields that were not configured", () => {
    const sanitized = sanitizeMachineConfig({
      id: "keyless",
      label: "Keyless",
      type: "ssh",
      ssh: { host: "keyless.example.test", username: "ops" },
    });

    expect(Object.keys(sanitized.ssh ?? {}).sort()).toEqual(["host", "username"]);
  });

  it("passes local machines through untouched", () => {
    const sanitized = sanitizeMachineConfigs([{ id: "local", label: "Local", type: "local" }]);
    expect(sanitized).toEqual([{ id: "local", label: "Local", type: "local" }]);
  });
});
