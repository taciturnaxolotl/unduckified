# Unduck

![dark and light modes of the app](.github/images/both.webp)

> [!IMPORTANT]
> This is a fork of [t3dotgg/unduck](https://github.com/t3dotgg/unduck) and I am not the original creator of this project. Do go checkout Theo's hosted version at [unduck.link](https://unduck.link) for the original experience which is a bit simpler then this mess of mine :)

DuckDuckGo's bang redirects are too slow. Add the following URL as a custom search engine to your browser. Enables all of DuckDuckGo's bangs to work, but much faster.

```
https://unduck.link?q=%s
```

## How is it that much faster?

DuckDuckGo does their redirects server side. Their DNS is...not always great. Result is that it often takes ages.

I solved this by doing all of the work client side. Once you've went to https://unduck.link once, the JS is all cache'd and will never need to be downloaded again. Your device does the redirects, not me.

## How is this different from Theo's version again?

This is primarily my personal fork to experiment with PWAs but I do have a few ideas that I would love to add to this.

- [x] Bangs
- [ ] Search History (clearable ofc and all local)
- [x] Dark Mode
- [x] Settings (for things like disabling search history and changing default bang)

and then some more really ambitious stuff like:

> [!NOTE]
> Umm yeah, I know I might not get to all of that and yes this is essentially me finally discovering PWAs and wanting to smash everything into one lol.

- [ ] Omptimistic UI chat wrapper (basically [t3.chat](https://t3.chat) but entirely on your own machine and completely free and unlimited and oss)
- [ ] Meta search engine as the default bang (so you can search Google, Bing, Yahoo, etc. all at once) this one is inspired by [mat-1/metasearch2](https://github.com/mat-1/metasearch2) but without the middleman server.

## Screenshots

<details>
    <summary>Spoiler Alert: It's just a search string you can copy</summary>

### Light Mode

![Light Mode](.github/images/light.webp)

### Dark Mode 💪

![Dark Mode](.github/images/dark.webp)

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
