/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-012（読み込み中）
 */
const LoadingScreen = () => (
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
    {[0, 1, 2].map((i) => (
      <li
        key={i}
        style={{
          height: 'var(--fs-3)',
          width: `${80 - i * 15}%`,
          background: 'var(--surface)',
          borderRadius: 'var(--radius-s)',
        }}
      />
    ))}
  </ul>
)

export default LoadingScreen
