import type { ClientModule } from 'claude-code'

// The cell where a button last went down, which press that was (counted
// from 1), whether it is still held, and whether it has left that cell.
type Held = { press: number; x: number; y: number; isDown: boolean; moved: boolean }

// A transparent layer over the drawing that turns a held button into
// drag offsets for the hooks module: cells moved since the press,
// so a post that a later one replaces within a frame loses nothing.
// A left press let go without leaving its cell is a click instead, posted
// with where it fell, to the fraction of a cell where the surface knows it.
//
// Any button drags. The desktop holds a pane's redraws while the left button
// is down in it and draws the last one on release, so only a middle or right
// drag shows the drawing following the pointer.
const Drag: ClientModule<{ columns: number; rows: number }, Held> = (size, surface) => {
  surface.onPointer(e => {
    const held = surface.state
    if (e.type === 'down') {
      surface.setState({ press: (held?.press ?? 0) + 1, x: e.x, y: e.y, isDown: true, moved: false })
    } else if (e.type === 'up' && held?.isDown) {
      surface.setState({ ...held, isDown: false })
      if (!held.moved && e.button === 'left') surface.post({ click: { x: e.fine?.x ?? e.x + 0.5, y: e.fine?.y ?? e.y + 0.5 } })
    } else if (e.type === 'move' && held?.isDown) {
      if (e.x !== held.x || e.y !== held.y) surface.setState({ ...held, moved: true })
      surface.post({ press: held.press, dx: e.x - held.x, dy: e.y - held.y })
    }
  })
  return surface.elements.Box({ width: size.columns, height: size.rows })
}

export default Drag
