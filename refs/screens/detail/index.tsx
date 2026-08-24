/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-003（詳細画面で情報が多い）/ C-004（主要操作が2つ以上ある）
 */
import { useState } from 'react'

const DetailScreen = () => {
  const [expanded, setExpanded] = useState(false)

  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <h1 style={{ fontSize: 'var(--fs-5)', color: 'var(--text)', margin: 0 }}>主要な情報</h1>

      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <button
          style={{
            padding: 'var(--sp-2) var(--sp-3)',
            fontSize: 'var(--fs-2)',
            color: 'var(--bg)',
            background: 'var(--accent)',
            border: 'none',
            borderRadius: 'var(--radius-s)',
          }}
        >
          主操作
        </button>
        <button
          style={{
            padding: 'var(--sp-2) var(--sp-3)',
            fontSize: 'var(--fs-2)',
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
          }}
        >
          副操作
        </button>
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          fontSize: 'var(--fs-2)',
          color: 'var(--accent)',
          background: 'none',
          border: 'none',
          textAlign: 'left',
          padding: 0,
        }}
      >
        {expanded ? '詳細を閉じる' : 'さらに詳細を見る'}
      </button>
      {expanded && (
        <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>
          折りたたまれていた補足情報。
        </p>
      )}
    </article>
  )
}

export default DetailScreen
