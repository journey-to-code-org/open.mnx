// The same list as await-tracked.zb, written as a JSX component.
import { resource } from '@zubra/runtime'

export default function ZbAwaitTrackedJsx({ org = 'acme' }) {
  let page = 1
  const list = resource(async ({ signal }) => {
    const token = await window.auth(signal)
    window.calls.push(`${org}/${page}`)
    return `${org}:${page}:${token}`
  })
  return (
    <>
      <p class="value">{list.value}</p>
      <button onClick={() => page++}>next</button>
    </>
  )
}
