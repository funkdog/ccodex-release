import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";

export async function squadFixture(t, run = async context => context.onText("received"), options = {}) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "squad-flow-"));
  const prompts = [];
  const events = [];
  const promptListeners = new Set();
  const engine = { adapter: "fixture", models: async () => [{ id: "model", name: "Fixture" }],
    run: async context => { prompts.push(context); for (const listener of promptListeners) listener(context); await run(context); } };
  const config = { home, endpoint: path.join(home, "gateway.sock"), token: randomUUID(), generation: "squad-flow" };
  const start = () => startGateway({ ...config, engines: new Map([["fixture", engine]]), defaultEngine: "fixture", ...options });
  let gateway = await start(), socket, peer;
  const connect = async () => {
    peer = new RpcPeer(message => writeMessage(socket, message));
    peer.onNotification = message => events.push(message);
    socket = await connectGateway(config, message => peer.receive(message));
    await peer.request("initialize", {});
  };
  await connect();
  const call = (method, params = {}) => peer.request(method, params);
  const createThread = async () => (await call("thread/start", { cwd: home, model: "fixture/model" })).thread;
  t.after(async () => { peer.close(); socket.destroy(); await gateway.close(); await fs.rm(home, { recursive: true, force: true }); });
  return { home, config, get gateway() { return gateway; }, call, createThread, prompts, events,
    waitForPrompt(predicate) {
      const received = prompts.find(predicate); if (received) return Promise.resolve(received);
      return new Promise(resolve => { const listener = context => { if (predicate(context)) { promptListeners.delete(listener); resolve(context); } }; promptListeners.add(listener); });
    },
    async restart() { peer.close(); socket.destroy(); await gateway.close(); gateway = await start(); await connect(); } };
}
