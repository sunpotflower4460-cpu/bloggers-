/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-022（選択肢が多い）
 */
import { useMemo, useState } from 'react'

const options = ['東京', '大阪', '名古屋', '福岡', '札幌', '仙台', '広島']

const SelectScreen = () => {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => options.filter((o) => o.includes(query)), [query])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="探す"
        style={{
          padding: 'var(--sp-2)',
          fontSize: 'var(--fs-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-s)',
        }}
      />
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--sp-1)',
        }}
      >
        {filtered.map((o) => (
          <li key={o} style={{ padding: 'var(--sp-2)', fontSize: 'var(--fs-2)', color: 'var(--text)' }}>
            {o}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default SelectScreen
