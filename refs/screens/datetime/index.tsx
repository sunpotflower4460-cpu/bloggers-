/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-043（日時を表示する）
 */
const DatetimeScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
    <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>一覧: 3日前</p>
    <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>詳細: 2026年8月21日 09:12</p>
  </div>
)

export default DatetimeScreen
