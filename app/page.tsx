import DriveMaker from "./drive-maker";

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brandMark">C</div>
        <div><p className="eyebrow">ENGLISH CLINIC WORKSPACE</p><h1>클리닉 제작실</h1></div>
        <span className="privacyBadge">비공개</span>
      </header>
      <DriveMaker />
    </main>
  );
}
