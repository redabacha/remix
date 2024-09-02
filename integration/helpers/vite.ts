import type { Page } from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import dedent from "dedent";
import execa from "execa";
import fse from "fs-extra";
import getPort from "get-port";
import glob from "glob";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import url from "node:url";
import shell from "shelljs";
import stripIndent from "strip-indent";
import waitOn from "wait-on";

const denoBin = "deno"; // assume deno is globally installed
const remixBin = "node_modules/@remix-run/dev/dist/cli.js";
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const root = path.resolve(__dirname, "../..");
const TMP_DIR = path.join(root, ".tmp/integration");

export const viteConfig = {
  server: async (args: { port: number; fsAllow?: string[] }) => {
    let { port, fsAllow } = args;
    let hmrPort = await getPort();
    let text = dedent`
      server: {
        port: ${port},
        strictPort: true,
        hmr: { port: ${hmrPort} },
        fs: { allow: ${fsAllow ? JSON.stringify(fsAllow) : "undefined"} }
      },
    `;
    return text;
  },
  basic: async (args: { port: number; fsAllow?: string[] }) => {
    return dedent`
      import { vitePlugin as remix } from "@remix-run/dev";

      export default {
        ${await viteConfig.server(args)}
        plugins: [remix()]
      }
    `;
  },
};

export const EXPRESS_SERVER = (args: {
  port: number;
  loadContext?: Record<string, unknown>;
}) =>
  String.raw`
    import { createRequestHandler } from "@remix-run/express";
    import { installGlobals } from "@remix-run/node";
    import express from "express";

    installGlobals({ nativeFetch: true });

    let viteDevServer =
      process.env.NODE_ENV === "production"
        ? undefined
        : await import("vite").then((vite) =>
            vite.createServer({
              server: { middlewareMode: true },
            })
          );

    const app = express();

    if (viteDevServer) {
      app.use(viteDevServer.middlewares);
    } else {
      app.use(
        "/assets",
        express.static("build/client/assets", { immutable: true, maxAge: "1y" })
      );
    }
    app.use(express.static("build/client", { maxAge: "1h" }));

    app.all(
      "*",
      createRequestHandler({
        build: viteDevServer
          ? () => viteDevServer.ssrLoadModule("virtual:remix/server-build")
          : await import("./build/index.js"),
        getLoadContext: () => (${JSON.stringify(args.loadContext ?? {})}),
      })
    );

    const port = ${args.port};
    app.listen(port, () => console.log('http://localhost:' + port));
  `;

type TemplateName =
  | "vite-template"
  | "vite-cloudflare-template"
  | "vite-deno-template";

export async function createProject(
  files: Record<string, string> = {},
  templateName: TemplateName = "vite-template"
) {
  let projectName = `remix-${Math.random().toString(32).slice(2)}`;
  let projectDir = path.join(TMP_DIR, projectName);
  await fse.ensureDir(projectDir);

  // base template
  let templateDir = path.resolve(__dirname, templateName);
  await fse.copy(templateDir, projectDir, { errorOnExist: true });

  // user-defined files
  await Promise.all(
    Object.entries(files).map(async ([filename, contents]) => {
      let filepath = path.join(projectDir, filename);
      await fse.ensureDir(path.dirname(filepath));
      await fse.writeFile(filepath, stripIndent(contents));
    })
  );

  return projectDir;
}

// Avoid "Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env
// being set" in vite-ecosystem-ci which breaks empty stderr assertions. To fix
// this we always ensure that only NO_COLOR is set after spreading process.env.
const colorEnv = {
  FORCE_COLOR: undefined,
  NO_COLOR: "1",
} as const;

export const viteBuild = ({
  cwd,
  env = {},
}: {
  cwd: string;
  env?: Record<string, string>;
}) => {
  let nodeBin = process.argv[0];

  return spawnSync(nodeBin, [remixBin, "vite:build"], {
    cwd,
    env: {
      ...process.env,
      ...colorEnv,
      ...env,
    },
  });
};

export const viteBuildDeno = ({
  cwd,
  env = {},
}: {
  cwd: string;
  env?: Record<string, string>;
}) => {
  return spawnSync(denoBin, ["run", "-A", remixBin, "vite:build"], {
    cwd,
    env: {
      ...process.env,
      ...colorEnv,
      ...env,
    },
  });
};

export const viteRemixServe = async ({
  cwd,
  port,
  serverBundle,
  basename,
}: {
  cwd: string;
  port: number;
  serverBundle?: string;
  basename?: string;
}) => {
  let nodeBin = process.argv[0];
  let serveProc = spawn(
    nodeBin,
    [
      "node_modules/@remix-run/serve/dist/cli.js",
      `build/server/${serverBundle ? serverBundle + "/" : ""}index.js`,
    ],
    {
      cwd,
      stdio: "pipe",
      env: { NODE_ENV: "production", PORT: port.toFixed(0) },
    }
  );
  await waitForServer(serveProc, { port, basename });
  return () => serveProc.kill();
};

export const wranglerPagesDev = async ({
  cwd,
  port,
}: {
  cwd: string;
  port: number;
}) => {
  let nodeBin = process.argv[0];

  // grab wrangler bin from remix-run/remix root node_modules since its not copied into integration project's node_modules
  let wranglerBin = path.resolve("node_modules/wrangler/bin/wrangler.js");

  let proc = spawn(
    nodeBin,
    [wranglerBin, "pages", "dev", "./build/client", "--port", String(port)],
    {
      cwd,
      stdio: "pipe",
      env: { NODE_ENV: "production" },
    }
  );
  await waitForServer(proc, { port });
  return () => proc.kill();
};

type ServerArgs = {
  cwd: string;
  port: number;
  env?: Record<string, string>;
  basename?: string;
};

const createDev =
  (args: string[], runtime = node, waitOnAddress = "localhost") =>
  async ({ cwd, port, env, basename }: ServerArgs): Promise<() => unknown> => {
    let proc = runtime(args, { cwd, env });
    await waitForServer(proc, { port, basename }, waitOnAddress);
    return () => proc.kill();
  };

export const viteDev = createDev([remixBin, "vite:dev"]);
export const viteDevDeno = createDev(
  ["run", "-A", remixBin, "vite:dev"],
  deno,
  "127.0.0.1" // https://github.com/jeffbski/wait-on/issues/109
);

export const customDev = createDev(["./server.mjs"]);

// Used for testing errors thrown on build when we don't want to start and
// wait for the server
export const viteDevCmd = ({ cwd }: { cwd: string }) => {
  let nodeBin = process.argv[0];
  return spawnSync(nodeBin, [remixBin, "vite:dev"], {
    cwd,
    env: { ...process.env },
  });
};

declare module "@playwright/test" {
  interface Page {
    errors: Error[];
  }
}

export type Files = (args: { port: number }) => Promise<Record<string, string>>;
type Fixtures = {
  page: Page;
  viteDev: (
    files: Files,
    templateName?: TemplateName
  ) => Promise<{
    port: number;
    cwd: string;
  }>;
  viteDevDeno: (
    files: Files,
    templateName?: TemplateName
  ) => Promise<{
    port: number;
    cwd: string;
  }>;
  customDev: (files: Files) => Promise<{
    port: number;
    cwd: string;
  }>;
  viteRemixServe: (files: Files) => Promise<{
    port: number;
    cwd: string;
  }>;
  wranglerPagesDev: (files: Files) => Promise<{
    port: number;
    cwd: string;
  }>;
};

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    page.errors = [];
    page.on("pageerror", (error: Error) => page.errors.push(error));
    await use(page);
  },
  // eslint-disable-next-line no-empty-pattern
  viteDev: async ({}, use) => {
    let stop: (() => unknown) | undefined;
    await use(async (files, template) => {
      let port = await getPort();
      let cwd = await createProject(await files({ port }), template);
      stop = await viteDev({ cwd, port });
      return { port, cwd };
    });
    stop?.();
  },
  // eslint-disable-next-line no-empty-pattern
  viteDevDeno: async ({}, use) => {
    let stop: (() => unknown) | undefined;
    await use(async (files, template) => {
      let port = await getPort();
      let cwd = await createProject(await files({ port }), template);
      // nasty hacks to try get windows msedge integration test to pass
      await execa(denoBin, ["install", "--no-lock"], {
        cwd,
        // @ts-expect-error broken global
        env: { DENO_FUTURE: "1" },
        stdio: "inherit",
      });
      await execa(
        process.argv[0],
        [
          "./scripts/copy-build-to-dist.mjs",
          `--deno-node-modules-paths=${cwd}/node_modules`,
        ],
        { stdio: "inherit" }
      );
      stop = await viteDevDeno({ cwd, port });
      return { port, cwd };
    });
    stop?.();
  },
  // eslint-disable-next-line no-empty-pattern
  customDev: async ({}, use) => {
    let stop: (() => unknown) | undefined;
    await use(async (files) => {
      let port = await getPort();
      let cwd = await createProject(await files({ port }));
      stop = await customDev({ cwd, port });
      return { port, cwd };
    });
    stop?.();
  },
  // eslint-disable-next-line no-empty-pattern
  viteRemixServe: async ({}, use) => {
    let stop: (() => unknown) | undefined;
    await use(async (files) => {
      let port = await getPort();
      let cwd = await createProject(await files({ port }));
      let { status } = viteBuild({ cwd });
      expect(status).toBe(0);
      stop = await viteRemixServe({ cwd, port });
      return { port, cwd };
    });
    stop?.();
  },
  // eslint-disable-next-line no-empty-pattern
  wranglerPagesDev: async ({}, use) => {
    let stop: (() => unknown) | undefined;
    await use(async (files) => {
      let port = await getPort();
      let cwd = await createProject(
        await files({ port }),
        "vite-cloudflare-template"
      );
      let { status } = viteBuild({ cwd });
      expect(status).toBe(0);
      stop = await wranglerPagesDev({ cwd, port });
      return { port, cwd };
    });
    stop?.();
  },
});

function node(
  args: string[],
  options: { cwd: string; env?: Record<string, string> }
) {
  let nodeBin = process.argv[0];

  let proc = spawn(nodeBin, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...colorEnv,
      ...options.env,
    },
    stdio: "pipe",
  });
  return proc;
}

function deno(
  args: string[],
  options: { cwd: string; env?: Record<string, string> }
) {
  let proc = spawn(denoBin, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...colorEnv,
      ...options.env,
    },
    stdio: "pipe",
  });
  return proc;
}

async function waitForServer(
  proc: ChildProcess & { stdout: Readable; stderr: Readable },
  args: { port: number; basename?: string },
  waitOnAddress = "localhost"
) {
  let devStdout = bufferize(proc.stdout);
  let devStderr = bufferize(proc.stderr);

  await waitOn({
    resources: [`http://${waitOnAddress}:${args.port}${args.basename ?? "/"}`],
    timeout: 10000,
  }).catch((err) => {
    let stdout = devStdout();
    let stderr = devStderr();
    proc.kill();
    throw new Error(
      [
        err.message,
        "",
        "exit code: " + proc.exitCode,
        "stdout: " + stdout ? `\n${stdout}\n` : "<empty>",
        "stderr: " + stderr ? `\n${stderr}\n` : "<empty>",
      ].join("\n")
    );
  });
}

function bufferize(stream: Readable): () => string {
  let buffer = "";
  stream.on("data", (data) => (buffer += data.toString()));
  return () => buffer;
}

export function createEditor(projectDir: string) {
  return async (file: string, transform: (contents: string) => string) => {
    let filepath = path.join(projectDir, file);
    let contents = await fs.readFile(filepath, "utf8");
    await fs.writeFile(filepath, transform(contents), "utf8");
  };
}

export function grep(cwd: string, pattern: RegExp): string[] {
  let assetFiles = glob.sync("**/*.@(js|jsx|ts|tsx)", {
    cwd,
    absolute: true,
  });

  let lines = shell
    .grep("-l", pattern, assetFiles)
    .stdout.trim()
    .split("\n")
    .filter((line) => line.length > 0);
  return lines;
}
