// Khyxx Digitals - E-Commerce & Interactive Client Engine

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Shrinks big payment screenshots in the browser so they upload quickly and fit the server limit.
window.khyxxCompressImage = function (file, maxBytes = 800 * 1024) {
  return new Promise(resolve => {
    if (!file || file.size <= maxBytes) return resolve(file);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob && blob.size < file.size ? blob : file), 'image/jpeg', 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
};

const storedCart = JSON.parse(localStorage.getItem('khyxx-cart') || '[]');
const cart = Array.isArray(storedCart) ? storedCart.map(item => ({
  ...item,
  quantity: Number(item.quantity) || 1
})) : [];

const cartDrawer = document.querySelector('.cart-drawer');
const overlay = document.querySelector('.overlay');
const cartItems = document.querySelector('.cart-items');
const productDetailsPanel = document.querySelector('.product-details-panel');
const productDetailsTitle = document.querySelector('#product-details-title');
const productDetailsType = document.querySelector('.product-details-type');
const productDetailsImage = document.querySelector('.product-details-image');
const productPreviewLink = document.querySelector('.product-preview-link');
const productInclusions = document.querySelector('.product-inclusions');
const detailsAddToCart = document.querySelector('.details-add-to-cart');
const header = document.querySelector('.site-header');
const navLinks = Array.from(document.querySelectorAll('.nav a[href^="#"]'));
let activeDetailsTrigger = null;

function saveCart() {
  localStorage.setItem('khyxx-cart', JSON.stringify(cart));
}

function formatPrice(value) {
  return `₱${Number(value || 0).toLocaleString()}`;
}

function updateHeaderState() {
  header?.classList.toggle('scrolled', window.scrollY > 8);
}

function setActiveNavLink(sectionId) {
  navLinks.forEach(link => {
    const isActive = link.getAttribute('href') === `#${sectionId}`;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

function updateActiveNavFromScroll() {
  const headerHeight = header?.getBoundingClientRect().height || 0;
  const scrollPosition = window.scrollY + headerHeight + 80;
  const sections = Array.from(document.querySelectorAll('main[id], section[id]'));

  let activeId = 'home';
  sections.forEach(section => {
    if (section.id && section.offsetTop <= scrollPosition) {
      activeId = section.id;
    }
  });

  setActiveNavLink(activeId);
}

function scrollToSection(sectionId) {
  const target = document.getElementById(sectionId);
  if (!target) return;
  const headerHeight = header?.getBoundingClientRect().height || 0;
  const top = window.pageYOffset + target.getBoundingClientRect().top - headerHeight - 12;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  window.scrollTo({ top, behavior });
}

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const sectionRevealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      sectionRevealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('main section:not(.hero)').forEach(section => {
    section.classList.add('section-reveal');
    sectionRevealObserver.observe(section);
  });
}

function renderCart() {
  const countEl = document.querySelector('.cart-count');
  const totalEl = document.querySelector('.cart-total');

  const totalItems = cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
  const totalPrice = cart.reduce((sum, item) => sum + (item.price * (item.quantity || 1)), 0);

  if (countEl) countEl.textContent = String(totalItems);
  if (totalEl) totalEl.textContent = formatPrice(totalPrice);

  if (cartItems) {
    if (!cart.length) {
      cartItems.innerHTML = '<p class="empty">Your bag is waiting for something lovely.</p>';
    } else {
      cartItems.innerHTML = cart.map((item, index) => `
        <div class="cart-line">
          <div class="cart-line-info">
            <strong>${esc(item.name)}</strong><br>
            <span style="font-size: 0.82rem; color: #87777a;">${formatPrice(item.price)} each</span><br>
            <strong style="color: var(--wine); font-size: 0.9rem;">${formatPrice(item.price * (item.quantity || 1))}</strong>
          </div>
          <div class="cart-line-controls">
            <button class="qty-btn" data-action="dec" data-index="${index}" aria-label="Decrease quantity">−</button>
            <span class="qty-value">${item.quantity || 1}</span>
            <button class="qty-btn" data-action="inc" data-index="${index}" aria-label="Increase quantity">+</button>
            <button class="button secondary" style="padding: 4px 8px; font-size: 0.65rem; margin-left: 6px;" data-remove="${index}" aria-label="Remove ${esc(item.name)}">×</button>
          </div>
        </div>
      `).join('');
    }
  }
}

function toggleCart(open) {
  if (!cartDrawer || !overlay) return;
  if (open) toggleProductDetails(false);
  cartDrawer.classList.toggle('open', open);
  overlay.classList.toggle('visible', open);
  cartDrawer.setAttribute('aria-hidden', String(!open));
}

function toggleProductDetails(open, imageButton) {
  if (!productDetailsPanel || !overlay) return;
  if (open && imageButton) {
    activeDetailsTrigger = imageButton;
    productDetailsTitle.textContent = imageButton.dataset.detailsTitle;
    productDetailsType.textContent = imageButton.dataset.detailsType;
    if (imageButton.dataset.detailsImage) {
      productDetailsImage.src = imageButton.dataset.detailsImage;
      productDetailsImage.alt = `${imageButton.dataset.detailsTitle} preview`;
      productDetailsImage.hidden = false;
    } else {
      productDetailsImage.hidden = true;
    }
    if (imageButton.dataset.detailsPreview) {
      productPreviewLink.href = imageButton.dataset.detailsPreview;
      productPreviewLink.hidden = false;
    } else {
      productPreviewLink.hidden = true;
    }
    productInclusions.innerHTML = imageButton.dataset.inclusions
      .split('|')
      .map(inclusion => `<li>${esc(inclusion)}</li>`)
      .join('');
    
    const relatedBtn = imageButton.closest('.product')?.querySelector('.add-to-cart');
    if (relatedBtn) {
      detailsAddToCart.dataset.name = relatedBtn.dataset.name;
      detailsAddToCart.dataset.price = relatedBtn.dataset.price;
      detailsAddToCart.disabled = relatedBtn.disabled;
      detailsAddToCart.classList.toggle('is-unavailable', relatedBtn.disabled);
    }
  }
  if (open) toggleCart(false);
  if (!open && productDetailsPanel.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  productDetailsPanel.classList.toggle('open', open);
  overlay.classList.toggle('visible', open);
  productDetailsPanel.setAttribute('aria-hidden', String(!open));
  if (!open) activeDetailsTrigger?.focus();
}

function addItemToCart(button) {
  if (button.disabled) return;
  const name = button.dataset.name;
  const price = Number(button.dataset.price);
  if (!name || Number.isNaN(price)) return;

  const existingItem = cart.find(item => item.name === name);
  if (existingItem) {
    existingItem.quantity = (existingItem.quantity || 1) + 1;
  } else {
    cart.push({ name, price, quantity: 1 });
  }

  saveCart();
  renderCart();
  toggleCart(true);

  const originalText = button.textContent;
  button.textContent = 'Added to bag ✓';
  setTimeout(() => { button.textContent = originalText; }, 1200);
}

// Global cart listeners
document.querySelectorAll('.add-to-cart').forEach(button => {
  button.addEventListener('click', () => addItemToCart(button));
});

document.querySelectorAll('.product-image[data-details-title]').forEach(imageButton => {
  imageButton.addEventListener('click', () => toggleProductDetails(true, imageButton));
});

detailsAddToCart?.addEventListener('click', () => addItemToCart(detailsAddToCart));

cartItems?.addEventListener('click', event => {
  const target = event.target;
  if (target.dataset.remove !== undefined) {
    cart.splice(Number(target.dataset.remove), 1);
    saveCart();
    renderCart();
    return;
  }

  if (target.dataset.action) {
    const idx = Number(target.dataset.index);
    if (cart[idx]) {
      if (target.dataset.action === 'inc') {
        cart[idx].quantity = (cart[idx].quantity || 1) + 1;
      } else if (target.dataset.action === 'dec') {
        if (cart[idx].quantity > 1) {
          cart[idx].quantity -= 1;
        } else {
          cart.splice(idx, 1);
        }
      }
      saveCart();
      renderCart();
    }
  }
});

document.querySelector('.cart-button')?.addEventListener('click', () => toggleCart(true));
document.querySelector('.close-cart')?.addEventListener('click', () => toggleCart(false));
document.querySelector('.close-details')?.addEventListener('click', () => toggleProductDetails(false));
overlay?.addEventListener('click', () => {
  toggleCart(false);
  toggleProductDetails(false);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    toggleCart(false);
    toggleProductDetails(false);
  }
});

// ==================== CHECKOUT SYSTEM ==================== //

function showCheckoutForm() {
  if (!cart.length) {
    alert('Your bag is currently empty. Please select a lovely invitation or template first!');
    return;
  }

  toggleCart(false);

  const modal = document.createElement('div');
  modal.className = 'checkout-modal';
  modal.innerHTML = `
    <form class="checkout-form" aria-labelledby="checkout-title">
      <button class="close-checkout" type="button" aria-label="Close checkout">×</button>
      <div class="checkout-brand"><span>Khyxx</span> Digitals<small>secure order checkout</small></div>
      <p class="eyebrow">step 1 of 2 · client & payment</p>
      <h2 id="checkout-title">Your Order Details</h2>
      <p class="checkout-intro">Enter your contact details and preferred payment method to finalize your order.</p>

      <div class="details-fields">
        <label>Your Full Name<input required name="name" placeholder="e.g. Camille Rodriguez" autocomplete="name" /></label>
        <label>Email Address<input required type="email" name="email" placeholder="camille@example.com" autocomplete="email" /></label>
        <label style="grid-column: 1 / -1;">Facebook / Contact Link<input required type="url" name="facebookLink" placeholder="https://facebook.com/your-profile" /></label>
      </div>

      <fieldset class="payment-methods">
        <legend>Select Payment Option</legend>
        <label class="payment-option">
          <input required type="radio" name="paymentMethod" value="gcash" checked />
          <span>
            <strong>GCash (0956 568 2259)</strong>
            <small>Instant payment · S****** K*** D*****</small>
          </span>
        </label>
        <label class="payment-option">
          <input type="radio" name="paymentMethod" value="bank_transfer" />
          <span>
            <strong>BPI Bank Transfer (4046 6419 04)</strong>
            <small>Online banking / InstaPay · S****** K*** T***** D*****</small>
          </span>
        </label>
      </fieldset>

      <div style="margin: 6px 0 12px; text-align: center;">
        <a href="store/mop.png" target="_blank" style="font-size: 0.82rem; color: var(--wine); text-decoration: underline; font-weight: 600;">
          📲 View & Scan Official InstaPay QR Code (GCash & BPI)
        </a>
      </div>

      <div style="background: #faf6f5; border: 1px solid #dec4b6; border-radius: 6px; padding: 12px; margin: 10px 0 14px;">
        <label style="font-size: 0.82rem; font-weight: 600; color: var(--wine); margin-bottom: 4px; display: block;">
          Payment Reference / Ref No. (Optional)
          <input name="paymentReference" placeholder="Enter 12-digit ref no. if already paid via app" style="width: 100%; margin-top: 4px; margin-bottom: 10px;" />
        </label>

        <label style="font-size: 0.82rem; font-weight: 600; color: var(--wine); margin-bottom: 4px; display: block;">
          Upload Proof of Payment (Screenshot)
          <input type="file" name="receipt" id="checkout-receipt-input" accept="image/*" style="width: 100%; margin-top: 4px; font-size: 0.8rem; background: #fff;" />
        </label>
        <div id="receipt-preview-wrap" style="display: none; margin-top: 8px; text-align: center;">
          <img id="receipt-preview-img" src="" alt="Receipt Preview" style="max-height: 120px; border-radius: 4px; border: 1px solid #dec4b6; box-shadow: 0 2px 8px rgba(0,0,0,0.08);" />
        </div>
      </div>

      <div class="checkout-summary">
        <div class="summary-heading">
          Your bag <span>${cart.reduce((s, i) => s + (i.quantity || 1), 0)} piece(s)</span>
        </div>
        ${cart.map(item => `
          <span>
            ${esc(item.name)} (x${item.quantity || 1})
            <strong>${formatPrice(item.price * (item.quantity || 1))}</strong>
          </span>
        `).join('')}
        <span class="summary-total">
          <b>Total Due</b>
          <strong>${formatPrice(cart.reduce((t, i) => t + (i.price * (i.quantity || 1)), 0))}</strong>
        </span>
      </div>

      <p class="checkout-error" role="alert"></p>
      <button class="button button-dark" type="submit" id="checkout-submit-btn">
        Confirm Order & Proceed <span>→</span>
      </button>
    </form>
  `;
  document.body.append(modal);

  const form = modal.querySelector('form');
  const error = modal.querySelector('.checkout-error');
  const receiptInput = modal.querySelector('#checkout-receipt-input');
  const previewWrap = modal.querySelector('#receipt-preview-wrap');
  const previewImg = modal.querySelector('#receipt-preview-img');
  const close = () => modal.remove();
  modal.querySelector('.close-checkout').addEventListener('click', close);

  receiptInput?.addEventListener('change', () => {
    const file = receiptInput.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = e => {
        previewImg.src = e.target.result;
        previewWrap.style.display = 'block';
      };
      reader.readAsDataURL(file);
    } else {
      previewWrap.style.display = 'none';
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submitBtn = modal.querySelector('#checkout-submit-btn');
    error.textContent = '';

    const name = form.elements.name.value.trim();
    const email = form.elements.email.value.trim();
    const facebookLink = form.elements.facebookLink.value.trim();
    const paymentMethod = form.elements.paymentMethod.value;
    const paymentReference = form.elements.paymentReference.value.trim();
    const receiptFile = receiptInput?.files?.[0];

    if (!name || !email) {
      error.textContent = 'Please fill out your full name and email address.';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating your order...';

    const orderPayload = {
      customer: { name, email, facebookLink },
      event: { facebookLink },
      // Only names and quantities are sent. Prices are looked up on the server.
      items: cart.map(item => ({ name: item.name, quantity: item.quantity || 1 })),
      paymentMethod,
      paymentReference
    };

    const resetSubmit = () => {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Confirm Order & Proceed <span>→</span>';
    };

    let orderId = '';
    let orderTotal = 0;
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        error.textContent = data.error || 'We could not place your order. Please try again, or message us on Facebook.';
        resetSubmit();
        return; // keep the bag so nothing is lost
      }
      orderId = data.orderId;
      orderTotal = data.total;
    } catch (err) {
      console.warn('Order request failed:', err);
      error.textContent = 'We could not reach the shop right now. Please check your connection and try again, or message us on Facebook.';
      resetSubmit();
      return;
    }

    let paymentMessage = `Next step: Send payment via <strong>${esc(paymentMethod.toUpperCase())}</strong> and upload your receipt screenshot.`;
    if (receiptFile) {
      try {
        const smallFile = await window.khyxxCompressImage(receiptFile);
        const formData = new FormData();
        formData.append('receipt', smallFile, 'receipt.jpg');
        if (paymentReference) formData.append('referenceNumber', paymentReference);
        formData.append('paymentMethod', paymentMethod);
        const up = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payment`, { method: 'POST', body: formData });
        if (up.ok) {
          paymentMessage = '✅ Proof of payment uploaded! We will verify your transaction shortly.';
        } else {
          const d = await up.json().catch(() => ({}));
          paymentMessage = `⚠️ Your order is saved, but the screenshot did not upload (${esc(d.error || 'unknown error')}). Open Track Order to upload it again.`;
        }
      } catch (e) {
        paymentMessage = '⚠️ Your order is saved, but the screenshot did not upload. Open Track Order to upload it again.';
      }
    } else if (paymentReference) {
      paymentMessage = '✅ Reference number received! We will verify your payment shortly.';
    }

    // Reset and clear cart
    localStorage.removeItem('khyxx-cart');
    cart.length = 0;
    saveCart();
    renderCart();

    // Show Order Success Screen
    modal.innerHTML = `
      <div class="checkout-form order-details-success">
        <span class="sparkle-icon">✦</span>
        <p class="eyebrow">order created</p>
        <h2 style="color: var(--wine);">Congratulations!</h2>
        <p class="checkout-intro">Thank you, <strong>${esc(name)}</strong>! Your order has been placed. Total due: <strong>${formatPrice(orderTotal)}</strong>.</p>

        <div style="background: #fff; border: 1px solid #dec4b6; padding: 16px; border-radius: 6px; margin: 18px 0; text-align: center;">
          <small style="text-transform: uppercase; color: #87777a; letter-spacing: 0.08em; display: block;">Your Order Code</small>
          <strong style="font-size: 1.5rem; color: var(--wine); letter-spacing: 0.05em; display: block; margin: 6px 0;">${orderId}</strong>
          <button type="button" class="button secondary" style="padding: 4px 10px; font-size: 0.72rem;" onclick="navigator.clipboard.writeText('${orderId}'); alert('Order code copied!');">
            Copy Order Code 📋
          </button>
        </div>

        <p style="font-size: 0.85rem; color: #705b5f;">
          ${paymentMessage}
        </p>

        <div style="display: grid; gap: 8px; margin-top: 20px;">
          <a href="track-order.html?id=${encodeURIComponent(orderId)}" class="button button-dark" style="text-align: center; text-decoration: none;">
            Track Order & View Payment Info <span>→</span>
          </a>
          <a href="https://www.facebook.com/share/196Nm6DMZN/" target="_blank" class="button secondary" style="text-align: center; text-decoration: none;">
            Message us on Facebook
          </a>
          <button class="button secondary close-success-btn" type="button">Close Window</button>
        </div>
      </div>
    `;

    modal.querySelector('.close-success-btn')?.addEventListener('click', close);

    const confirmation = document.querySelector('.order-confirmation');
    if (confirmation) {
      confirmation.innerHTML = `Order <strong>${orderId}</strong> received! Track your order anytime on <a href="track-order.html?id=${orderId}">the tracking portal</a>.`;
      confirmation.classList.add('visible');
    }
  });
}

document.querySelector('.checkout')?.addEventListener('click', showCheckoutForm);

// ==================== PRODUCT FILTERS ==================== //

const productSearch = document.querySelector('#product-search');
const productSearchClear = document.querySelector('.shop-search-clear');
const productSearchStatus = document.querySelector('.shop-search-status');
const productGrid = document.querySelector('.product-grid');
const catalogProducts = Array.from(document.querySelectorAll('.product'));
let activeProductFilter = document.querySelector('.filter.active')?.dataset.filter || 'all';

catalogProducts.forEach(product => {
  product.dataset.searchText = [
    product.textContent,
    product.querySelector('.product-image')?.dataset.detailsTitle,
    product.querySelector('.product-image')?.dataset.detailsType,
    product.querySelector('.product-image')?.dataset.inclusions
  ].filter(Boolean).join(' ').toLowerCase();
});

function orderCatalogProducts(filterName) {
  if (!productGrid) return;

  if (filterName !== 'all') {
    catalogProducts.forEach(product => productGrid.append(product));
    return;
  }

  const printables = catalogProducts.filter(product => product.dataset.category === 'invitation');
  const websites = catalogProducts.filter(product => product.dataset.category === 'website');
  const mixedProducts = [];
  const mixedCount = Math.max(printables.length, websites.length);

  for (let index = 0; index < mixedCount; index += 1) {
    if (printables[index]) mixedProducts.push(printables[index]);
    if (websites[index]) mixedProducts.push(websites[index]);
  }

  mixedProducts.push(...catalogProducts.filter(product =>
    product.dataset.category !== 'invitation' && product.dataset.category !== 'website'
  ));
  mixedProducts.forEach(product => productGrid.append(product));
}

function applyCatalogFilters() {
  const query = productSearch?.value.trim().toLowerCase() || '';
  let visibleCount = 0;

  catalogProducts.forEach(product => {
    const matchesCategory = activeProductFilter === 'all' || product.dataset.category === activeProductFilter;
    const matchesSearch = !query || product.dataset.searchText.includes(query);
    const shouldShow = matchesCategory && matchesSearch;
    product.classList.toggle('hidden', !shouldShow);
    if (shouldShow) visibleCount += 1;
  });

  if (productSearchStatus) {
    productSearchStatus.textContent = query
      ? `${visibleCount} ${visibleCount === 1 ? 'design' : 'designs'} found for “${productSearch.value.trim()}”.`
      : `${visibleCount} designs available`;
  }
  if (productSearchClear) productSearchClear.hidden = !query;
}

function setActiveFilter(filterName) {
  const activeFilter = document.querySelector('.filter.active');
  const nextFilter = document.querySelector(`.filter[data-filter="${filterName}"]`);

  if (activeFilter) activeFilter.classList.remove('active');
  if (nextFilter) nextFilter.classList.add('active');
  activeProductFilter = filterName;
  orderCatalogProducts(filterName);
  orderCatalogProducts(activeProductFilter);
  applyCatalogFilters();
}

document.querySelectorAll('.filter').forEach(filter => {
  filter.addEventListener('click', () => {
    setActiveFilter(filter.dataset.filter);
    const catalogHeading = document.querySelector('.shop-page-shell .shop-catalog-heading');
    if (catalogHeading) {
      const headerHeight = header?.getBoundingClientRect().height || 0;
      const top = window.pageYOffset + catalogHeading.getBoundingClientRect().top - headerHeight - 12;
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      window.scrollTo({ top, behavior });
    }
  });
});

applyCatalogFilters();

productSearch?.addEventListener('input', applyCatalogFilters);
productSearchClear?.addEventListener('click', () => {
  if (!productSearch) return;
  productSearch.value = '';
  applyCatalogFilters();
  productSearch.focus();
});

if (catalogProducts.length) applyCatalogFilters();

// ==================== TESTIMONIALS QUOTE CAROUSEL ==================== //

const quotes = [
  ['“Thank you po pala, ma’am. Ang ganda ng invitation namin. 😍😍”', '— Mark Jay'],
  ['“Overall po ang ganda poooo. Maraming maraming salamt po 🥺”', '— Client feedback'],
  ['“Ganda po nung gawa niyo worth ittttt ang antay 😅💗”', '— Client feedback']
];
let quoteIndex = 0;
let feedbackNextCount = 0;

function changeQuote(direction) {
  quoteIndex = (quoteIndex + direction + quotes.length) % quotes.length;
  const textEl = document.querySelector('#quote-text');
  const authorEl = document.querySelector('#quote-author');
  if (textEl) textEl.textContent = quotes[quoteIndex][0];
  if (authorEl) authorEl.textContent = quotes[quoteIndex][1];
}

document.querySelector('.next')?.addEventListener('click', () => {
  changeQuote(1);
  feedbackNextCount = (feedbackNextCount + 1) % quotes.length;
  document.querySelector('.feedback-gallery')?.classList.toggle('visible', feedbackNextCount !== 0);
});

document.querySelector('.previous')?.addEventListener('click', () => changeQuote(-1));

// ==================== NAVIGATION & MOBILE MENU ==================== //

document.querySelectorAll('.nav a[href^="#"]').forEach(link => {
  link.addEventListener('click', event => {
    const href = link.getAttribute('href');
    if (!href || href === '#') return;
    const targetId = href.slice(1);
    const target = document.getElementById(targetId);
    if (!target) return;
    event.preventDefault();
    setActiveNavLink(targetId);
    scrollToSection(targetId);
    window.history.replaceState(null, '', href);
    document.querySelector('.nav')?.classList.remove('open');
  });
});

document.querySelector('.menu-toggle')?.addEventListener('click', event => {
  const nav = document.querySelector('.nav');
  nav?.classList.toggle('open');
  event.currentTarget.setAttribute('aria-expanded', String(nav?.classList.contains('open')));
});

document.querySelectorAll('.nav a').forEach(link => {
  link.addEventListener('click', () => document.querySelector('.nav')?.classList.remove('open'));
});

// Window lifecycle listeners
window.addEventListener('scroll', () => {
  updateHeaderState();
  updateActiveNavFromScroll();
}, { passive: true });

window.addEventListener('load', () => {
  updateHeaderState();
  updateActiveNavFromScroll();
  renderCart();
});
