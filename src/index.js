export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    return new Response(
      JSON.stringify(
        {
          ok: true,
          service: "cf-worker-quota",
          environment: env.ENVIRONMENT || "production",
          method: request.method,
          path: url.pathname,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      ),
      {
        headers: {
          "content-type": "application/json;charset=UTF-8",
          "cache-control": "no-store",
        },
      }
    );
  },
};
