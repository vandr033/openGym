import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { WorkoutRow, workoutDetailSheet, logPastWorkoutSheet, logCardioSessionSheet } from '../sheets.jsx'
import { Button } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'

export default function History() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  return <>
    <div className="hdr"><button className="iconbtn" onClick={() => nav('/stats')} aria-label={t('Stats')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('History')}</h1><div className="sub">{t('{0} workouts', S.workouts.length)}</div></div></div>
    <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
      <Button icon="plus" onClick={logPastWorkoutSheet}>{t('Log a past workout')}</Button>
      <Button icon="figureRun" variant="ghost" onClick={logCardioSessionSheet}>{t('Log cardio')}</Button>
    </div>
    {S.workouts.length ? <div className="list">{[...S.workouts].reverse().map(w => <WorkoutRow key={w.id} w={w} onClick={() => workoutDetailSheet(w)} />)}</div>
      : <div className="empty"><div className="ico"><Icon name="history" /></div>{t('No workouts yet.')}</div>}
  </>
}
