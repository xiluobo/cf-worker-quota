# cf-worker-quota

A minimal Cloudflare Worker project scaffold for deployment.

## Local development

```bash
npm install
npx wrangler login
npm run dev
```

## Production deployment

```bash
npm install
npx wrangler login
npm run deploy
```

If your Cloudflare account has a production environment configured, you can also run:

```bash
npm run deploy:prod
```

## Notes

- `wrangler.toml` defines the Worker name and entry point.
- `src/index.js` is the Worker handler.
- The project is ready to publish to the `cf-worker-quota` Worker in Cloudflare.
