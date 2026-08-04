# Hanyou Zheng Homepage

Source for [Hanyou Zheng's academic homepage](https://zzzhy03.github.io/).
The site is built with Next.js and exported as static files for GitHub Pages.

## Local development

```bash
npm ci
npm run dev
```

Open <http://localhost:3000> after the development server starts.

## Build

```bash
npm run build
```

The static site is generated in `out/`. Pushing to the `main` branch triggers
the GitHub Pages deployment workflow in `.github/workflows/deploy-pages.yml`.

The local `ZHY-Resume/`, `zzzhy03/`, and `local-assets/` directories are not
part of this public repository.
