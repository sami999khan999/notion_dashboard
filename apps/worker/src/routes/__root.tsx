import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { Shell } from '../components/Shell'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // Private dashboard — keep it out of any crawler that reaches it.
      { name: 'robots', content: 'noindex, nofollow' },
      { name: 'color-scheme', content: 'light' },
      { title: 'Notion Ops' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Shell>{children}</Shell>
        <Scripts />
      </body>
    </html>
  )
}
