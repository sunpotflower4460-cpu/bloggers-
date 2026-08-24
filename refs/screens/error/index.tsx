/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-013（エラー：通信）
 */
const ErrorScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
    <p style={{ fontSize: 'var(--fs-2)', color: 'var(--text)', margin: 0 }}>
      通信に失敗しました。もう一度お試しください
    </p>
    <button
      style={{
        padding: 'var(--sp-2) var(--sp-3)',
        fontSize: 'var(--fs-2)',
        color: 'var(--accent)',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-s)',
      }}
    >
      もう一度試す
    </button>
  </div>
)

export default ErrorScreen
