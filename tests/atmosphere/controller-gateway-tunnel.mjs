// AiaB-only fixed TCP tunnel. TLS terminates only at the pinned gateway.
import net from "node:net";
import { isIP } from "node:net";
const address = process.env.CONTROLLER_GATEWAY_ADDRESS;
if (isIP(address ?? "") !== 4) throw Error("Invalid gateway address");
const server = net.createServer((client) => {
  const upstream = net.connect({ host: address, port: 3444 });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream).pipe(client);
});
server.listen(3444, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());
