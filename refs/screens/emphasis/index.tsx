/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-051（情報を強調したいとき）
 */
const EmphasisScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>通常の情報</p>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>通常の情報</p>
    <p style={{ fontSize: 'var(--fs-4)', color: 'var(--text)', margin: 'var(--sp-3) 0' }}>強調したい情報</p>
    <p style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', margin: 0 }}>通常の情報</p>
  </div>
)

export default EmphasisScreen
