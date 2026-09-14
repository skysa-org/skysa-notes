import { Outlet, createRootRoute } from '@tanstack/react-router'
import { UpdatePrompt } from '../components/UpdatePrompt'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
    <div className="app">
      <Outlet />
      <UpdatePrompt />
    </div>
  )
}
