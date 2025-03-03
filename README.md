# Unduck

![dark and light modes of the app](.github/images/both.webp)

> [!IMPORTANT]
> This is a fork of [t3dotgg/unduck](https://github.com/t3dotgg/unduck). Check out Theo's hosted version at [unduck.link](https://unduck.link) for the original experience.

## Quick Start

Add this URL as a custom search engine to your browser to use DuckDuckGo's bangs, but faster:
```
https://s.dunkirk.sh?q=%s
```

## How is it that much faster?

DuckDuckGo does their redirects server side. Their DNS is...not always great. Result is that it often takes ages.

I solved this by doing all of the work client side. Once you've went to https://s.dunkirk.sh once, the JS is all cache'd and will never need to be downloaded again. Your device does the redirects, not me or any other server.

## How is this different from Theo's version again?

This is primarily my personal fork to experiment with PWAs but I do have a few ideas that I would love to add to this.

- [x] Bangs
- [x] Dark Mode
- [x] Settings (for things like disabling search history and changing default bang)
- [x] Search counter
- [x] [OpenSearch](https://developer.mozilla.org/en-US/docs/Web/XML/Guides/OpenSearch) support
- [x] Search History (clearable, all local, and disabled by default ofc)
- [x] Fancy sounds (disabled if you have `prefers-reduced-motion` set; sounds only account for 201.3 KB of the 707 KB total size)
- [x] Cute little text animations
- [ ] ~Search suggestions~ (as far as I can tell this essentially impossible to do natively with either firefox or chrome; please correct me if I'm wrong though. In this case I would very much love to be wrong)

and then some more really ambitious stuff like:

> [!NOTE]
> Umm yeah, I know I might not get to all of that and yes this is essentially me finally discovering PWAs and wanting to smash everything into one lol.

- [ ] Omptimistic UI chat wrapper (basically [t3.chat](https://t3.chat) but entirely on your own machine and completely free and unlimited and oss)
- [ ] Meta search engine as the default bang (so you can search Google, Bing, Yahoo, etc. all at once) this one is inspired by [mat-1/metasearch2](https://github.com/mat-1/metasearch2) but without the middleman server.

## Fancy smancy technical graphs 😮

The total size of the app is 707 KB (one time download)

### Resource Breakdown

```mermaid
graph TD
    subgraph Resources by Size
        A[index-DDeT9iuD.js<br/>contains all the ddg bangs<br/>445 KB]
        B[Font File<br/>48.9 KB]
        subgraph Audio Files
            C[Audio Files<br/>195.3 KB Total]
        end
        subgraph Small Assets
            D[SVGs & CSS<br/>~10 KB]
        end
    end
```

### Network Performance

```mermaid
gantt
    title Network Waterfall Chart
    dateFormat  HH:mm:ss.SSS
    axisFormat  %L
    
    section Initial HTML
    GET / (3.1 KB)           :done, h1, 07:13:59.714, 114ms
    
    section JavaScript
    beacon.min.js            :done, b1, 07:13:59.900, 0ms
    index-DDeT9iuD.js (445 KB) :done, j1, 07:13:59.901, 32ms
    registerSW.js (2.2 KB)   :done, j2, 07:13:59.914, 69ms
    beacon.min.js (2nd)      :done, b2, 07:14:00.035, 0ms
    
    section Styles
    CSS Font (2.1 KB)        :done, c1, 07:13:59.900, 110ms
    Main CSS (3.6 KB)        :done, c2, 07:13:59.902, 32ms
    Font File (48.9 KB)      :done, f1, 07:14:00.051, 165ms
    
    section Assets
    gear.svg (2.4 KB)        :done, s1, 07:14:00.105, 30ms
    clipboard.svg (2.3 KB)   :done, s2, 07:14:00.106, 29ms
    search.svg (2.3 KB)      :done, s3, 07:14:00.220, 30ms
    
    section Audio
    heavier-tick.mp3 (22.4 KB) :done, a1, 07:14:00.107, 30ms
    toggle-off.mp3 (34.3 KB) :done, a2, 07:14:00.109, 30ms
    toggle-on.mp3 (34.3 KB)  :done, a3, 07:14:00.110, 42ms
    click.mp3 (35.7 KB)      :done, a4, 07:14:00.111, 38ms
    double.mp3 (34.3 KB)     :done, a5, 07:14:00.113, 41ms
    foot-switch.mp3 (34.3 KB):done, a6, 07:14:00.113, 36ms
```

## Screenshots

<details>
    <summary>Spoiler Alert: There is both a light and a dark mode 🤯</summary>

### Light Mode

![Light Mode](.github/images/light.webp)
![Light Mode with Search History](.github/images/light-history.webp)

### Dark Mode 💪

![Dark Mode](.github/images/dark.webp)
![Dark Mode with Search History](.github/images/dark-history.webp)

</details>

<p align="center">
	<img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/master/.github/images/line-break.svg" />
</p>

<p align="center">
	<i><code>&copy 2025-present <a href="https://github.com/taciturnaxolotl">Kieran Klukas</a> forked from <a href="https://github.com/t3dotgg/unduck">t3dotgg/unduck</a></code></i>
</p>

<p align="center">
	<a href="https://github.com/taciturnaxolotl/unduck/blob/master/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
