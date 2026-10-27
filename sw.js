"use strict";

const CACHE_NAME = "dfb-license-admin-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./portal.css",
  "./portal.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];
const CACHED_PATHS = new Set([
  "",
  "index.html",
  "portal.css",
  "portal.js",
  "config.js",
  "manifest.webmanifest",
  "favicon.png",
  "icon-192.png",
  "icon-512.png",
]);
const APP_ROOT = new URL("./", self.location.href).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("dfb-license-admin-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.cache === "no-store") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(APP_ROOT)) return;
  const relativePath = url.pathname.slice(APP_ROOT.length).replace(/^\/+/, "");
  if (!CACHED_PATHS.has(relativePath)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cachedResponse = await cache.match(request, { ignoreSearch: true });
      if (cachedResponse) return cachedResponse;
      if (request.mode === "navigate") {
        const offlinePage = await cache.match("./index.html");
        if (offlinePage) return offlinePage;
      }
      throw error;
    }
  })());
});
