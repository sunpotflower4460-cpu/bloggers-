/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-041（見出しと本文の階層をつける）
 */
const TypographyScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
    <h1 style={{ fontSize: 'var(--fs-6)', color: 'var(--text)', margin: 0 }}>見出し1</h1>
    <h2 style={{ fontSize: 'var(--fs-4)', color: 'var(--text)', margin: 0 }}>見出し2</h2>
    <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>本文</p>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>補足</p>
  </div>
)

export default TypographyScreen
