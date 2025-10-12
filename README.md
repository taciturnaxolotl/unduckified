# Unduckified

![dark and light modes of the app](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/both.webp)

> This is a fork of [t3dotgg/unduck](https://github.com/t3dotgg/unduck). Check out Theo's hosted version at [unduck.link](https://unduck.link) for the original experience.

## Quick Start

Add this URL as a custom search engine to your browser to use DuckDuckGo's bangs, but faster:

```
https://s.dunkirk.sh?q=%s
```

## How is it that much faster?

DuckDuckGo does their redirects server side. Their DNS is...not always great. Result is that it often takes ages.

I solved this by doing all of the work client side. Once you've went to https://s.dunkirk.sh once, the JS is all cached and will never need to be downloaded again. Your device does the redirects, not me or any other server.

## How is this different from Theo's version again?

This is primarily my personal fork to experiment with PWAs but I do have a few ideas that I would love to add to this.

<img align="right" width="140" height="140" src="https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/public/goose.gif" alt="goose walking animation"/>

- [x] Bangs
- [x] Dark Mode
- [x] Settings (for things like disabling search history and changing default bang)
- [x] Search counter
- [x] [OpenSearch](https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch) support
- [x] Search History (clearable, all local, and disabled by default ofc)
- [x] Fancy sounds (disabled if you have `prefers-reduced-motion` set; sounds only account for `198.5 KB` of the `717.4 KB` total size)
- [x] Cute little text animations
- [x] Auto updating bangs file! (I'm using a [GitHub Action](https://github.com/taciturnaxolotl/unduckified/actions/workflows/update-bangs.yaml) to update the bangs file every 24 hours)
- [x] Hashmapped bangs for faster searching
- [x] local font file to avoid google fonts
- [x] redirects to the base page of a bang if there is no query (e.g. `!g` will take you to google.com and `!yt` will take you to youtube.com)
- [x] Suffix bangs (e.g. `ghr! taciturnaxolotl/unduckified` will take you to this github repo)
- [x] Quick settings (e.g. `!settings` or `!` will take you to the settings page)
- [x] Custom local bangs! (thanks to [@ayoubabedrabbo@mastodon.social](https://mastodon.social/@ayoubabedrabbo/114114311682366314) for the suggestion)
- [x] Kagi bangs! We are able to grab the bangs from [kagisearch/bangs](https://github.com/kagisearch/bangs/) and Kagi is far more responsive than DuckDuckGo when it comes to updating their bangs.

## Search Suggestions

On firefox based browsers you can use the dedicated search suggestions url field but on most other browsers unless they have global search suggestions you are kind of out of luck. Thanks to [`KobeW50`](https://github.com/KobeW50) for bringing this to my attention! I added the urls for duckduckgo and chrome below and you can pick your poison on which one you would rather have see what you type in the url bar.

![search suggestions field on firefox](https://raw.githubusercontent.com/taciturnaxolotl/unduckified/main/.github/images/search-suggestions.jpeg)

```
https://duckduckgo.com/ac/?q=%s&type=list
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
