/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-002（リスト画面で項目が少ない）
 */
import type { FC } from 'react'

const items = [{ id: '1', title: 'Item 1' }]

const ListEmptyScreen: FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)' }}>
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-4)',
      }}
    >
      {items.map((item) => (
        <li
          key={item.id}
          style={{ padding: 'var(--sp-4)', fontSize: 'var(--fs-3)', color: 'var(--text)' }}
        >
          {item.title}
        </li>
      ))}
    </ul>
    <button
      style={{
        alignSelf: 'flex-start',
        padding: 'var(--sp-2) var(--sp-3)',
        fontSize: 'var(--fs-2)',
        color: 'var(--accent)',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-s)',
      }}
    >
      追加する
    </button>
  </div>
)

export default ListEmptyScreen
