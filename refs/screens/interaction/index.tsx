/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-031（タップのフィードバック）
 */
import { useState } from 'react'

const InteractionScreen = () => {
  const [pressed, setPressed] = useState(false)

  return (
    <button
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        padding: 'var(--sp-3) var(--sp-4)',
        fontSize: 'var(--fs-2)',
        color: 'var(--bg)',
        background: 'var(--accent)',
        border: 'none',
        borderRadius: 'var(--radius-s)',
        transform: pressed ? 'scale(0.97)' : 'scale(1)',
        transitionProperty: 'transform',
        transitionDuration: 'var(--dur)',
        transitionTimingFunction: 'var(--ease)',
      }}
    >
      タップする
    </button>
  )
}

export default InteractionScreen
