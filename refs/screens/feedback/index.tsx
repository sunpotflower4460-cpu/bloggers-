/**
 * 構造のみの参照実装。色・書体・余白は var(--token) 経由。
 * 対応する craft 項目: C-034（音と触覚）
 */
const FeedbackScreen = () => {
  const notify = () => {
    if ('vibrate' in navigator) {
      navigator.vibrate(10)
    }
  }

  return (
    <button
      onClick={notify}
      style={{
        padding: 'var(--sp-2) var(--sp-3)',
        fontSize: 'var(--fs-2)',
        color: 'var(--bg)',
        background: 'var(--accent)',
        border: 'none',
        borderRadius: 'var(--radius-s)',
      }}
    >
      完了を通知する
    </button>
  )
}

export default FeedbackScreen
