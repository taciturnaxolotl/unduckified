# Unduckified

![dark and light modes of the app](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/both.webp)

> This is a fork of [t3dotgg/unduck](https://github.com/t3dotgg/unduck). Check out Theo's hosted version at [unduck.link](https://unduck.link) for the original experience.

## Quick Start

Add this URL as a custom search engine to your browser to use DuckDuckGo's bangs, but faster:

```
https://s.dunkirk.sh?q=%s
```

## How is it that much faster?

DuckDuckGo does their redirects server side. Depending on how fast your internet connection is this can mean a network round trip that could cause a noticable delay vs directly loading the other website.

This is solved by doing all of the work client side. Once you've went to https://s.dunkirk.sh once, the JS is all cached and will never need to be downloaded again. Your device does the redirects, not unduck or any other server.

The exception is the very first search on a new browser profile, which has no Service Worker yet. That one navigation already carries your query to the edge in order to ask for the page, so it gets answered there with a redirect instead of a page plus a 189 KiB catalog download. The worker installs during that same visit and takes over from the second search onward. If you have custom bangs or a custom default provider, the edge steps aside and your browser resolves even that first search, since your settings never leave your device.

## Performance

A Service Worker intercepts the search before any page loads, so once the bang catalog is cached the redirect resolves on your device in **about half a millisecond** with no network at all, and the very first search of a profile is answered at the edge instead of waiting on a catalog download. Here are a few comparison benchmarks: median time from pressing Enter to the redirect committing, all measured the same way (see [BENCHMARK.md](BENCHMARK.md)). Absolute numbers vary a lot with your distance to each service's servers and your hardware but the ordering should be fairly stable.

| tool | how it redirects | warm search | worker restart | cold first search | bytes to first redirect |
|---|---|--:|--:|--:|--:|
| **unduckified** | Service Worker, plus an edge 302 for the first search | **~0.5 ms** | ~4.5 ms | **~70 ms** | **~0.4 KiB** |
| [flashbang](https://github.com/ph1losof/flashbang) | Service Worker + on-demand shards | **~0.5 ms** | **~3.9 ms** | ~119-134 ms | ~4-11 KiB |
| unduck (Theo's original) | page load, then JS redirect | ~33 ms | n/a | ~211 ms | ~472 KiB |
| rebang | Cloudflare edge worker | ~7.7 ms | n/a | **~67 ms** | ~0.4 KiB |
| DuckDuckGo | server-side redirect | ~30 ms | n/a | ~186 ms | ~5 KiB |

- **warm** is a live Service Worker; **restart** is one the browser has stopped and has to boot again (the normal case if you search a few times a day); **cold** is a brand-new profile that has to download everything.
- Warm and restart are on-device and never touch the network, which is the whole point: a Service Worker tool answers in half a millisecond where an edge tool pays a round trip on *every* search.
- Cold used to be the tradeoff, since a new profile had to download the whole catalog before it could resolve anything. It doesn't any more: the first navigation already carries the query to our edge, so it is answered there with a 302 and no body. That is a statistical tie with rebang (paired diff 1.8 ms, 95% CI [-3.2, 6.5], p=0.47) while keeping the on-device warm path.
- Against flashbang: warm is a wash (0.03 ms apart), restart goes to flashbang by 0.76 ms, and cold now goes to us by 40 ms on `!gh test` and 67 ms on `!github test` (both p < 0.0001, 27/30 and 29/30 paired rounds).
- Cold numbers are dominated by your network, not by either tool. These were all measured in one sitting from one machine, so read the gaps rather than the absolutes.

## How is this different from Theo's version again?

Great question! There are a lotttt of new features in addition to the crazy performance optimization that has been done. Here is a short list:

<img align="right" width="140" height="140" src="https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/public/goose.gif" alt="goose walking animation"/>

- [x] Bangs
- [x] Dark Mode
- [x] Settings (for things like enabling search history, changing default bang, and creating custom bangs)
- [x] Search counter
- [x] [OpenSearch](https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch) support
- [x] Fancy sounds (disabled if you have `prefers-reduced-motion` set and they are only `28kb`)
- [x] Cute little text animations
- [x] Auto updating bangs file! (I'm using a [GitHub Action](https://github.com/taciturnaxolotl/unduckified/actions/workflows/update-bangs.yaml) to update the bangs file every 24 hours)
- [x] Compact binary format for the bang catelog that requires no decode step
- [x] local font file to avoid google fonts
- [x] redirects to the base page of a bang if there is no query (e.g. `!g` will take you to google.com and `!yt` will take you to youtube.com)
- [x] Suffix bangs (e.g. `ghr! taciturnaxolotl/unduckified` will take you to this github repo)
- [x] Quick settings (e.g. `!settings` or `!` will take you to the settings page)
- [x] Custom local bangs! (thanks to [@ayoubabedrabbo@mastodon.social](https://mastodon.social/@ayoubabedrabbo/114114311682366314) for the suggestion)
- [x] Kagi bangs! We are able to grab the bangs from [kagisearch/bangs](https://github.com/kagisearch/bangs/) and Kagi is far more responsive than DuckDuckGo when it comes to updating their bangs.
- [x] A service worker! This lets us respond in as little time as possible directly intercepting the browser's network requests
- [x] Configurable search suggestions!

## Search Suggestions

On firefox based browsers you can use the dedicated search suggestions url field but on most other browsers unless they have global search suggestions you are kind of out of luck. Thanks to [`KobeW50`](https://github.com/KobeW50) for bringing this to my attention!

![search suggestions field on firefox](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/search-suggestions.jpeg)

Unduck now completes bangs itself! Point the suggestions field at:

```
https://s.dunkirk.sh/suggest?q=%s
```

Type `!git` and you get `!github`, `!githubdocs`, and so on, ordered by the duckduckgo bangs rank field. By default that is the only suggestions it provides however you can opt into two more features that expose your searches to other providers.

### Options

#### Plain-query forwarding.

With `&forwarder=<provider>`, a query with no bang is sent to the named engine. Providers are `ddg`, `google`, `bing`, `brave`, `yahoo`, `kagi`, `qwant`, and `startpage`. By default without this option a plain query gets no suggestions and leaves this service untouched. This also enables search suggestions when using a bang for a search engine like google, duckduckgo, or kagi.

```
https://s.dunkirk.sh/suggest?q=%s&forwarder=ddg
```

#### Site-specific suggestions.

With `&site_specific_forward=1`, a bang followed by a space forwards the rest to that service's own autocomplete where we have a suggestion url. For example `!github react` searches GitHub's repo search, `!wikipedia rust` searches Wikipedia. This does not include search engines if you have set `&forwarder=<provider>` as those will use your configured provider.

```
https://s.dunkirk.sh/suggest?q=%s&site_specific_forward=1
```
#### Plain completions

Both compose with each other and with the dropdown formatting. If your browser or search client would rather have the bare completions, drop the descriptions and favicons with `&rich=0`:

```
https://s.dunkirk.sh/suggest?q=%s&rich=0
```

### Privacy

Unfortunately this is the one piece of unduckified that cannot run on your device. Browsers fetch suggestions from the browser process rather than from a page, so a service worker never sees the request. There is an open [crbug 41389229](https://issues.chromium.org/issues/41389229) for Chrome (Firefox also behaves the same) but it looks unlikely to change anytime soon.

While suggestions are on, what you type in the address bar reaches the hosted edge function. Nothing is logged or stored but the request does leave your machine and there isn't a good way to audit the worker itself.

If you are strongly worried about privacy then I would disable search suggestions or self host them yourself. You can always use a suggestion provider that is different from the search engine. DuckDuckGo, Kagi, and Google's urls are included below.


```
https://duckduckgo.com/ac/?q=%s&type=list
```

```
https://kagisuggest.com/api/autosuggest?q=%s
```

```
https://www.google.com/complete/search?client=chrome&q=%s
```

## Screenshots

<details>
    <summary>open this to view the screenshots</summary>

### Light Mode

![Light Mode](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/light.webp)
![Light Mode with Search History](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/light-history.webp)
![Light Mode 404](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/light-404.webp)

### Dark Mode (the superior mode)

![Dark Mode](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/dark.webp)
![Dark Mode with Search History](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/dark-history.webp)
![Dark Mode 404](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/dark-404.webp)

</details>

<p align="center">
	<img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break.svg" />
</p>

<p align="center">
	<i><code>&copy 2025-present <a href="https://github.com/taciturnaxolotl">Kieran Klukas</a> forked from <a href="https://github.com/t3dotgg/unduck">t3dotgg/unduck</a></code></i>
</p>

<p align="center">
	<a href="https://github.com/taciturnaxolotl/unduckified/blob/main/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
