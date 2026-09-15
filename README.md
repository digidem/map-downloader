# Map Downloader

Map Downloader is a web app for downloading an area of a map as a [Styled Map Package](https://github.com/digidem/styled-map-package) (.smp) for offline use in [CoMapeo](https://comapeo.app). Pick a map style (a built-in preset, a MapLibre style URL, a raster tile URL template, or a local .mbtiles file), draw a bounding box, choose a max zoom, and download.

Each preset lists its attribution and usage restrictions (offline download, commercial use, redistribution); you are responsible for complying with the terms of the map source you download from. You can also add GeoJSON overlays to the map (not supported on mobile / small screens).

The SMP is generated in a web worker with [styled-map-package-api](https://github.com/digidem/styled-map-package) and streamed to disk through a service worker, so large downloads aren't held in memory. Local .mbtiles files are read with [sqlite-wasm](https://github.com/sqlite/sqlite-wasm) from [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

## Development

```bash
npm install
npm run dev
```

## Testing

```bash
npm run test:e2e:install
npm test
```

## Deployment

```bash
npm run deploy   # build + deploy to Cloudflare Workers (static assets)
```

Or run `npm run build` and upload the `dist` directory to a host that sets the cross-origin isolation headers in `public/_headers`.
