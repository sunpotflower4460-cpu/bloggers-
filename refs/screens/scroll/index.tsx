/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-032（スクロールと固定要素）
 */
const items = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`)

const ScrollScreen = () => (
  <div style={{ position: 'relative', height: '100%', overflow: 'auto' }}>
    <div
      style={{
        position: 'sticky',
        top: 0,
        padding: 'var(--sp-2)',
        fontSize: 'var(--fs-2)',
        color: 'var(--text)',
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      主要操作
    </div>
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 'var(--sp-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
      }}
    >
      {items.map((item) => (
        <li key={item} style={{ fontSize: 'var(--fs-2)', color: 'var(--text)' }}>
          {item}
        </li>
      ))}
    </ul>
  </div>
)

export default ScrollScreen
