/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-001（リスト画面で項目が多い）
 */
import type { FC } from 'react'

interface ListItem {
  id: string
  title: string
}

const items: ListItem[] = [
  { id: '1', title: 'Item 1' },
  { id: '2', title: 'Item 2' },
  { id: '3', title: 'Item 3' },
]

const ListScreen: FC = () => (
  <ul
    style={{
      listStyle: 'none',
      margin: 0,
      padding: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--sp-2)',
    }}
  >
    {items.map((item) => (
      <li
        key={item.id}
        style={{
          padding: 'var(--sp-2) var(--sp-3)',
          fontSize: 'var(--fs-2)',
          color: 'var(--text)',
        }}
      >
        {item.title}
      </li>
    ))}
  </ul>
)

export default ListScreen
