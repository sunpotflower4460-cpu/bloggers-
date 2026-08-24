/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-042（数字と単位を表示する）
 */
const NumbersScreen = () => (
  <p style={{ margin: 0, color: 'var(--text)' }}>
    <span style={{ fontSize: 'var(--fs-6)' }}>12,480</span>
    <span style={{ fontSize: 'var(--fs-1)', color: 'var(--text-muted)', marginLeft: 'var(--sp-1)' }}>歩</span>
  </p>
)

export default NumbersScreen
