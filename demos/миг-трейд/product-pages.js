const hamburger = document.querySelector('.hamburger');
const overlay = document.getElementById('mobileOverlay');
const closeBtn = document.getElementById('mobileClose');

if (hamburger && overlay && closeBtn) {
  hamburger.addEventListener('click', () => overlay.classList.add('active'));
  closeBtn.addEventListener('click', () => overlay.classList.remove('active'));
  overlay.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => overlay.classList.remove('active'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') overlay.classList.remove('active');
  });
}

window.addEventListener('load', () => {
  document.querySelectorAll('.reveal').forEach((element) => element.classList.add('animate'));
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));
});
