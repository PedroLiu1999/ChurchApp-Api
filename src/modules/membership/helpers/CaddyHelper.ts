import { Repos } from "../repositories/index.js";
import { RepoManager } from "../../../shared/infrastructure/index.js";
import axios from "axios";
import { Environment } from "../../../shared/helpers/index.js";

export interface HostDial {
  host: string;
  dial: string;
}

export class CaddyHelper {
  private static getAdminBaseUrl() {
    return "http://" + Environment.caddyHost + ":" + Environment.caddyPort;
  }

  private static sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper to PUT config, ignoring 409 conflict if key already exists
  private static async putConfig(url: string, data: any) {
    try {
      await axios.put(url, data, { timeout: 10000 });
    } catch (err: any) {
      // 409 means key already exists - that's fine, use PATCH to update
      if (err?.response?.status === 409) {
        await axios.patch(url, data, { timeout: 10000 });
      } else {
        throw err;
      }
    }
  }

  // Call once after Caddy restarts to set up storage and server structure
  static async initializeCaddy() {
    if (!Environment.caddyHost || !Environment.caddyPort) return;

    const baseUrl = this.getAdminBaseUrl();
    const results: string[] = [];

    try {
      // Configure cert storage — S3 if CADDY_CERT_BUCKET is set, otherwise use Caddy's default local storage
      const certBucket = process.env.CADDY_CERT_BUCKET || "";
      if (certBucket) {
        await this.putConfig(baseUrl + "/config/storage", {
          module: "s3",
          bucket: certBucket,
          region: process.env.AWS_REGION || "us-east-1",
          prefix: process.env.CADDY_CERT_PREFIX || "certs",
          ...(process.env.AWS_ENDPOINT_URL_S3 ? { endpoint: process.env.AWS_ENDPOINT_URL_S3 } : {})
        });
        results.push("storage: ok (s3)");
        await this.sleep(500);
      } else {
        results.push("storage: ok (local file)");
      }

      // Configure TLS automation with ACME email for Let's Encrypt
      await this.putConfig(baseUrl + "/config/apps/tls/automation/policies", [
        {
          issuers: [
            {
              module: "acme",
              email: process.env.CADDY_ACME_EMAIL || process.env.SUPPORT_EMAIL || ""
            }
          ]
        }
      ]);
      results.push("tls: ok");
      await this.sleep(500);

      // When running alongside a Caddyfile, Caddy already has srv0 on :443 and handles HTTP→HTTPS.
      // We only need TLS config (done above). Skip creating proxy/redirect servers.
      // If no Caddyfile is used, create the servers:
      try {
        const existingConfig = await axios.get(baseUrl + "/config/apps/http/servers/srv0", { timeout: 5000 });
        if (existingConfig.data) {
          results.push("proxy: skipped (Caddyfile srv0 exists)");
          results.push("http_redirect: skipped (Caddyfile manages)");
        }
      } catch {
        // No srv0 — create proxy and redirect servers from scratch
        await this.putConfig(baseUrl + "/config/apps/http/servers/proxy", {
          listen: [":443"],
          routes: []
        });
        results.push("proxy: ok (created)");
        await this.sleep(500);

        await this.putConfig(baseUrl + "/config/apps/http/servers/http_redirect", {
          listen: [":80"],
          routes: [
            {
              match: [{ path: ["/.well-known/acme-challenge/*"] }],
              handle: [{ handler: "static_response", status_code: 200 }]
            },
            {
              handle: [
                {
                  handler: "static_response",
                  status_code: 308,
                  headers: { Location: ["https://{http.request.host}{http.request.uri}"] }
                }
              ]
            }
          ]
        });
        results.push("http_redirect: ok (created)");
      }

      return { success: true, results };
    } catch (err: any) {
      return {
        success: false,
        results,
        error: err?.message || "Unknown error",
        step: results.length
      };
    }
  }

  // Updates routes on the active server — appends dynamic domain routes
  static async updateCaddy() {
    if (!Environment.caddyHost || !Environment.caddyPort) return;

    // Determine server name: srv0 (Caddyfile) or proxy (programmatic)
    const baseUrl = this.getAdminBaseUrl();
    let serverName = "proxy";
    try {
      await axios.get(baseUrl + "/config/apps/http/servers/srv0", { timeout: 5000 });
      serverName = "srv0";
    } catch { /* srv0 doesn't exist, use proxy */ }

    const adminUrl = baseUrl + `/config/apps/http/servers/${serverName}/routes`;
    const existingRoutes = await axios.get(adminUrl, { timeout: 10000 }).then(r => r.data).catch(() => []);
    const dynamicRoutes = await this.generateRoutes();

    // Filter out existing dynamic routes (non-Caddyfile routes that have terminal: true and reverse_proxy with tls transport)
    const staticRoutes = (existingRoutes || []).filter((r: any) => {
      const handler = r?.handle?.[0];
      if (handler?.handler === "subroute") {
        const innerHandler = handler?.routes?.[0]?.handle?.[0];
        // Dynamic routes use tls transport; Caddyfile routes don't
        return !innerHandler?.transport?.tls;
      }
      return true;
    });

    // Append dynamic routes after static Caddyfile routes
    const combined = [...staticRoutes, ...dynamicRoutes];
    await axios.patch(adminUrl, combined);
  }

  // Generates the full routes array from the database
  static async generateRoutes() {
    const repos = await RepoManager.getRepos<Repos>("membership");
    const hostDials: HostDial[] = (await repos.domain.loadPairs()) as HostDial[];
    const routes: any[] = [];

    // Add exact host routes first (order matters in Caddy)
    hostDials.forEach((hd) => {
      routes.push(this.getRoute(hd.host, hd.dial));
    });

    // Add www redirect routes after
    hostDials.forEach((hd) => {
      routes.push(this.getWwwRoute(hd.host));
    });

    return routes;
  }

  // Legacy method for backwards compatibility (used by /caddy and /test endpoints)
  static async generateJsonData() {
    const routes = await this.generateRoutes();
    return {
      apps: {
        http: {
          servers: {
            proxy: {
              listen: [":443"],
              routes
            }
          }
        }
      }
    };
  }

  private static getRoute(host: string, dial: string) {
    // Ensure dial has port
    const dialWithPort = dial.includes(":") ? dial : dial + ":443";

    return {
      match: [{ host: [host] }],
      handle: [
        {
          handler: "subroute",
          routes: [
            {
              handle: [
                {
                  handler: "reverse_proxy",
                  upstreams: [{ dial: dialWithPort }],
                  transport: {
                    protocol: "http",
                    tls: {}
                  },
                  headers: { request: { set: { Host: ["{http.reverse_proxy.upstream.hostport}"] } } }
                }
              ]
            }
          ]
        }
      ],
      terminal: true
    };
  }

  private static getWwwRoute(host: string) {
    return {
      match: [{ host: ["www." + host] }],
      handle: [
        {
          handler: "static_response",
          status_code: 302,
          headers: { Location: ["https://" + host + "{http.request.uri}"] }
        }
      ],
      terminal: true
    };
  }
}
