/* WebAssembly SIMD support */

#ifndef VEC_WASM_H
#define VEC_WASM_H

#include "common.h"
#include "opus_types.h"
#include <math.h>
#include <wasm_simd128.h>

#define MAX_INPUTS 2048
#define MAX_OUTPUTS 8192

/* Helper macros for WASM SIMD operations */
#define wasm_f32x4_fma(a, b, c) wasm_f32x4_add((a), wasm_f32x4_mul((b), (c)))

#ifndef LPCNET_TEST

/* Vectorized exp approximation (4 floats at a time) */
static inline v128_t exp4_approx(v128_t x) {
  v128_t i;
  v128_t xf;

  /* Clamp input to avoid overflow */
  x = wasm_f32x4_max(wasm_f32x4_min(x, wasm_f32x4_splat(88.f)),
                     wasm_f32x4_splat(-88.f));

  /* express exp(x) as exp2(x/log(2)), add 127 for the exponent later */
  x = wasm_f32x4_fma(wasm_f32x4_splat(127.f), x, wasm_f32x4_splat(1.44269504f));

  /* split into integer and fractional parts */
  i = wasm_i32x4_trunc_sat_f32x4(x);
  xf = wasm_f32x4_convert_i32x4(i);
  x = wasm_f32x4_sub(x, xf);

  /* Polynomial approximation of 2^x for x in [0,1) */
  v128_t K0 = wasm_f32x4_splat(0.99992522f);
  v128_t K1 = wasm_f32x4_splat(0.69583354f);
  v128_t K2 = wasm_f32x4_splat(0.22606716f);
  v128_t K3 = wasm_f32x4_splat(0.078024523f);

  v128_t Y =
      wasm_f32x4_fma(wasm_f32x4_fma(wasm_f32x4_fma(K3, x, K2), x, K1), x, K0);

  v128_t exp_bits = wasm_i32x4_shl(i, 23);
  Y = wasm_f32x4_mul(
      Y, (v128_t)wasm_i32x4_add(exp_bits,
                                wasm_i32x4_splat(0x3f800000 - (127 << 23))));

  return Y;
}

/* Simplified exp4 that's more numerically stable */
static inline v128_t exp4_approx_simple(v128_t x) {
  /* Clamp to prevent overflow */
  x = wasm_f32x4_max(wasm_f32x4_min(x, wasm_f32x4_splat(88.f)),
                     wasm_f32x4_splat(-88.f));

  /* exp(x) = 2^(x * log2(e)) = 2^(x * 1.44269504) */
  v128_t t = wasm_f32x4_mul(x, wasm_f32x4_splat(1.44269504f));

  /* Split into integer and fractional parts */
  v128_t ti = wasm_f32x4_floor(t);
  v128_t tf = wasm_f32x4_sub(t, ti);

  /* Polynomial approximation for 2^tf where tf is in [0, 1) */
  /* 2^x ≈ 1 + x*ln(2) + x^2*ln(2)^2/2 + ... */
  v128_t c0 = wasm_f32x4_splat(1.0f);
  v128_t c1 = wasm_f32x4_splat(0.693147180f); /* ln(2) */
  v128_t c2 = wasm_f32x4_splat(0.240226507f); /* ln(2)^2 / 2 */
  v128_t c3 = wasm_f32x4_splat(0.055504109f); /* ln(2)^3 / 6 */
  v128_t c4 = wasm_f32x4_splat(0.009618129f); /* ln(2)^4 / 24 */

  v128_t tf2 = wasm_f32x4_mul(tf, tf);
  v128_t tf3 = wasm_f32x4_mul(tf2, tf);
  v128_t tf4 = wasm_f32x4_mul(tf2, tf2);

  v128_t result = wasm_f32x4_add(
      c0,
      wasm_f32x4_add(wasm_f32x4_mul(c1, tf),
                     wasm_f32x4_add(wasm_f32x4_mul(c2, tf2),
                                    wasm_f32x4_add(wasm_f32x4_mul(c3, tf3),
                                                   wasm_f32x4_mul(c4, tf4)))));

  /* Multiply by 2^(integer part) using bit manipulation */
  v128_t int_part = wasm_i32x4_trunc_sat_f32x4(ti);
  v128_t exp_offset =
      wasm_i32x4_shl(wasm_i32x4_add(int_part, wasm_i32x4_splat(127)), 23);

  return wasm_f32x4_mul(result, (v128_t)exp_offset);
}

/* Vectorized tanh approximation */
static inline v128_t tanh4_approx(v128_t X) {
  const v128_t N0 = wasm_f32x4_splat(952.52801514f);
  const v128_t N1 = wasm_f32x4_splat(96.39235687f);
  const v128_t N2 = wasm_f32x4_splat(0.60863042f);
  const v128_t D0 = wasm_f32x4_splat(952.72399902f);
  const v128_t D1 = wasm_f32x4_splat(413.36801147f);
  const v128_t D2 = wasm_f32x4_splat(11.88600922f);
  const v128_t max_out = wasm_f32x4_splat(1.f);
  const v128_t min_out = wasm_f32x4_splat(-1.f);

  v128_t X2 = wasm_f32x4_mul(X, X);
  v128_t num = wasm_f32x4_fma(wasm_f32x4_fma(N2, X2, N1), X2, N0);
  v128_t den = wasm_f32x4_fma(wasm_f32x4_fma(D2, X2, D1), X2, D0);
  num = wasm_f32x4_mul(num, X);
  num = wasm_f32x4_div(num, den);
  return wasm_f32x4_max(min_out, wasm_f32x4_min(max_out, num));
}

/* Vectorized sigmoid approximation */
static inline v128_t sigmoid4_approx(v128_t X) {
  const v128_t N0 = wasm_f32x4_splat(238.13200378f);
  const v128_t N1 = wasm_f32x4_splat(6.02452230f);
  const v128_t N2 = wasm_f32x4_splat(0.00950985f);
  const v128_t D0 = wasm_f32x4_splat(952.72399902f);
  const v128_t D1 = wasm_f32x4_splat(103.34200287f);
  const v128_t D2 = wasm_f32x4_splat(0.74287558f);
  const v128_t half = wasm_f32x4_splat(0.5f);
  const v128_t max_out = wasm_f32x4_splat(1.f);
  const v128_t min_out = wasm_f32x4_splat(0.f);

  v128_t X2 = wasm_f32x4_mul(X, X);
  v128_t num = wasm_f32x4_fma(wasm_f32x4_fma(N2, X2, N1), X2, N0);
  v128_t den = wasm_f32x4_fma(wasm_f32x4_fma(D2, X2, D1), X2, D0);
  num = wasm_f32x4_mul(num, X);
  num = wasm_f32x4_add(half, wasm_f32x4_div(num, den));
  return wasm_f32x4_max(min_out, wasm_f32x4_min(max_out, num));
}

/* Scalar versions using vector operations */
static inline float lpcnet_exp(float x) {
  float out[4];
  v128_t X = wasm_f32x4_splat(x);
  v128_t Y = exp4_approx_simple(X);
  wasm_v128_store(out, Y);
  return out[0];
}

static inline float tanh_approx(float x) {
  float out[4];
  v128_t X = wasm_f32x4_splat(x);
  v128_t Y = tanh4_approx(X);
  wasm_v128_store(out, Y);
  return out[0];
}

static inline float sigmoid_approx(float x) {
  float out[4];
  v128_t X = wasm_f32x4_splat(x);
  v128_t Y = sigmoid4_approx(X);
  wasm_v128_store(out, Y);
  return out[0];
}

/* Vectorized activation functions */
static inline void softmax(float *y, const float *x, int N) {
  int i;
  for (i = 0; i < N - 3; i += 4) {
    v128_t X = wasm_v128_load(&x[i]);
    v128_t Y = exp4_approx_simple(X);
    wasm_v128_store(&y[i], Y);
  }
  for (; i < N; i++)
    y[i] = lpcnet_exp(x[i]);
}

static inline void vec_tanh(float *y, const float *x, int N) {
  int i;
  for (i = 0; i < N - 3; i += 4) {
    v128_t X = wasm_v128_load(&x[i]);
    v128_t Y = tanh4_approx(X);
    wasm_v128_store(&y[i], Y);
  }
  for (; i < N; i++) {
    y[i] = tanh_approx(x[i]);
  }
}

static inline void vec_sigmoid(float *y, const float *x, int N) {
  int i;
  for (i = 0; i < N - 3; i += 4) {
    v128_t X = wasm_v128_load(&x[i]);
    v128_t Y = sigmoid4_approx(X);
    wasm_v128_store(&y[i], Y);
  }
  for (; i < N; i++) {
    y[i] = sigmoid_approx(x[i]);
  }
}

#endif /* LPCNET_TEST */

/* Matrix-vector multiplication: 16 rows at a time */
static inline void sgemv16x1(float *out, const float *weights, int rows,
                             int cols, int col_stride, const float *x) {
  int i, j;
  for (i = 0; i < rows; i += 16) {
    float *restrict y = &out[i];

    /* Initialize accumulators */
    v128_t y0_3 = wasm_f32x4_splat(0);
    v128_t y4_7 = wasm_f32x4_splat(0);
    v128_t y8_11 = wasm_f32x4_splat(0);
    v128_t y12_15 = wasm_f32x4_splat(0);

    for (j = 0; j < cols; j++) {
      const float *restrict w = &weights[j * col_stride + i];

      /* Load weight vectors */
      v128_t wvec0_3 = wasm_v128_load(&w[0]);
      v128_t wvec4_7 = wasm_v128_load(&w[4]);
      v128_t wvec8_11 = wasm_v128_load(&w[8]);
      v128_t wvec12_15 = wasm_v128_load(&w[12]);

      /* Broadcast x[j] */
      v128_t xj = wasm_f32x4_splat(x[j]);

      /* Multiply-accumulate */
      y0_3 = wasm_f32x4_fma(y0_3, wvec0_3, xj);
      y4_7 = wasm_f32x4_fma(y4_7, wvec4_7, xj);
      y8_11 = wasm_f32x4_fma(y8_11, wvec8_11, xj);
      y12_15 = wasm_f32x4_fma(y12_15, wvec12_15, xj);
    }

    /* Store results */
    wasm_v128_store(&y[0], y0_3);
    wasm_v128_store(&y[4], y4_7);
    wasm_v128_store(&y[8], y8_11);
    wasm_v128_store(&y[12], y12_15);
  }
}

/* Matrix-vector multiplication: 8 rows at a time */
static inline void sgemv8x1(float *out, const float *weights, int rows,
                            int cols, int col_stride, const float *x) {
  int i, j;
  for (i = 0; i < rows; i += 8) {
    float *restrict y = &out[i];

    v128_t y0_3 = wasm_f32x4_splat(0);
    v128_t y4_7 = wasm_f32x4_splat(0);

    for (j = 0; j < cols; j++) {
      const float *restrict w = &weights[j * col_stride + i];

      v128_t wvec0_3 = wasm_v128_load(&w[0]);
      v128_t wvec4_7 = wasm_v128_load(&w[4]);

      v128_t xj = wasm_f32x4_splat(x[j]);

      y0_3 = wasm_f32x4_fma(y0_3, wvec0_3, xj);
      y4_7 = wasm_f32x4_fma(y4_7, wvec4_7, xj);
    }

    wasm_v128_store(&y[0], y0_3);
    wasm_v128_store(&y[4], y4_7);
  }
}

/* Generic matrix-vector multiplication */
static inline void sgemv(float *out, const float *weights, int rows, int cols,
                         int col_stride, const float *x) {
  if ((rows & 0xf) == 0)
    sgemv16x1(out, weights, rows, cols, col_stride, x);
  else if ((rows & 0x7) == 0)
    sgemv8x1(out, weights, rows, cols, col_stride, x);
  else {
    int i, j;
    for (i = 0; i < rows; i++) {
      out[i] = 0;
      for (j = 0; j < cols; j++)
        out[i] += weights[j * col_stride + i] * x[j];
    }
  }
}

/* Sparse matrix-vector multiplication */
static inline void sparse_sgemv8x4(float *out, const float *w, const int *idx,
                                   int rows, const float *x) {
  int i, j;
  RNN_CLEAR(out, rows);
  for (i = 0; i < rows; i += 8) {
    int cols;
    cols = *idx++;

    v128_t y0_3 = wasm_f32x4_splat(0);
    v128_t y4_7 = wasm_f32x4_splat(0);

    for (j = 0; j < cols; j++) {
      int pos;
      pos = (*idx++);

      float xj0 = x[pos + 0];
      float xj1 = x[pos + 1];
      float xj2 = x[pos + 2];
      float xj3 = x[pos + 3];

      /* Load weights for xj0 */
      v128_t w0_3 = wasm_v128_load(&w[0]);
      v128_t w4_7 = wasm_v128_load(&w[4]);
      v128_t vxj0 = wasm_f32x4_splat(xj0);
      y0_3 = wasm_f32x4_fma(y0_3, w0_3, vxj0);
      y4_7 = wasm_f32x4_fma(y4_7, w4_7, vxj0);

      /* Load weights for xj1 */
      v128_t w8_11 = wasm_v128_load(&w[8]);
      v128_t w12_15 = wasm_v128_load(&w[12]);
      v128_t vxj1 = wasm_f32x4_splat(xj1);
      y0_3 = wasm_f32x4_fma(y0_3, w8_11, vxj1);
      y4_7 = wasm_f32x4_fma(y4_7, w12_15, vxj1);

      /* Load weights for xj2 */
      v128_t w16_19 = wasm_v128_load(&w[16]);
      v128_t w20_23 = wasm_v128_load(&w[20]);
      v128_t vxj2 = wasm_f32x4_splat(xj2);
      y0_3 = wasm_f32x4_fma(y0_3, w16_19, vxj2);
      y4_7 = wasm_f32x4_fma(y4_7, w20_23, vxj2);

      /* Load weights for xj3 */
      v128_t w24_27 = wasm_v128_load(&w[24]);
      v128_t w28_31 = wasm_v128_load(&w[28]);
      v128_t vxj3 = wasm_f32x4_splat(xj3);
      y0_3 = wasm_f32x4_fma(y0_3, w24_27, vxj3);
      y4_7 = wasm_f32x4_fma(y4_7, w28_31, vxj3);

      w += 32;
    }

    wasm_v128_store(&out[i], y0_3);
    wasm_v128_store(&out[i + 4], y4_7);
  }
}

/* Quantized matrix-vector multiplication */
static inline void cgemv8x4(float *_out, const opus_int8 *w, const float *scale,
                            int rows, int cols, const float *_x) {
  int i, j;
  opus_int8 x[MAX_INPUTS];

  /* Quantize input to int8 */
  for (i = 0; i < cols; i += 4) {
    v128_t vx = wasm_v128_load(&_x[i]);
    v128_t scaled = wasm_f32x4_mul(vx, wasm_f32x4_splat(127.0f));
    v128_t rounded = wasm_f32x4_nearest(scaled);
    v128_t clamped =
        wasm_f32x4_max(wasm_f32x4_min(rounded, wasm_f32x4_splat(127.0f)),
                       wasm_f32x4_splat(-128.0f));
    v128_t ints = wasm_i32x4_trunc_sat_f32x4(clamped);

    /* Pack to int8 */
    x[i] = (opus_int8)wasm_i32x4_extract_lane(ints, 0);
    x[i + 1] = (opus_int8)wasm_i32x4_extract_lane(ints, 1);
    x[i + 2] = (opus_int8)wasm_i32x4_extract_lane(ints, 2);
    x[i + 3] = (opus_int8)wasm_i32x4_extract_lane(ints, 3);
  }

  for (i = 0; i < rows; i += 8) {
    int32_t acc[8] = {0};

    for (j = 0; j < cols; j += 4) {
      int xj0 = x[j];
      int xj1 = x[j + 1];
      int xj2 = x[j + 2];
      int xj3 = x[j + 3];

      /* Manual dot product for int8 weights */
      for (int k = 0; k < 8; k++) {
        acc[k] += w[k * 4 + 0] * xj0 + w[k * 4 + 1] * xj1 + w[k * 4 + 2] * xj2 +
                  w[k * 4 + 3] * xj3;
      }
      w += 32;
    }

    /* Scale and store */
    v128_t acc0_3 = wasm_i32x4_make(acc[0], acc[1], acc[2], acc[3]);
    v128_t acc4_7 = wasm_i32x4_make(acc[4], acc[5], acc[6], acc[7]);
    v128_t scale0_3 = wasm_v128_load(&scale[i]);
    v128_t scale4_7 = wasm_v128_load(&scale[i + 4]);

    wasm_v128_store(&_out[i],
                    wasm_f32x4_mul(wasm_f32x4_convert_i32x4(acc0_3), scale0_3));
    wasm_v128_store(&_out[i + 4],
                    wasm_f32x4_mul(wasm_f32x4_convert_i32x4(acc4_7), scale4_7));
  }
}

/* Sparse quantized matrix-vector multiplication */
static inline void sparse_cgemv8x4(float *_out, const opus_int8 *w,
                                   const int *idx, const float *scale, int rows,
                                   int cols, const float *_x) {
  int i, j;
  opus_int8 x[MAX_INPUTS];

  /* Quantize input to int8 */
  for (i = 0; i < cols; i += 4) {
    v128_t vx = wasm_v128_load(&_x[i]);
    v128_t scaled = wasm_f32x4_mul(vx, wasm_f32x4_splat(127.0f));
    v128_t rounded = wasm_f32x4_nearest(scaled);
    v128_t clamped =
        wasm_f32x4_max(wasm_f32x4_min(rounded, wasm_f32x4_splat(127.0f)),
                       wasm_f32x4_splat(-128.0f));
    v128_t ints = wasm_i32x4_trunc_sat_f32x4(clamped);

    x[i] = (opus_int8)wasm_i32x4_extract_lane(ints, 0);
    x[i + 1] = (opus_int8)wasm_i32x4_extract_lane(ints, 1);
    x[i + 2] = (opus_int8)wasm_i32x4_extract_lane(ints, 2);
    x[i + 3] = (opus_int8)wasm_i32x4_extract_lane(ints, 3);
  }

  for (i = 0; i < rows; i += 8) {
    int colblocks;
    int32_t acc[8] = {0};

    colblocks = *idx++;
    for (j = 0; j < colblocks; j++) {
      int pos = (*idx++);
      int xj0 = x[pos];
      int xj1 = x[pos + 1];
      int xj2 = x[pos + 2];
      int xj3 = x[pos + 3];

      for (int k = 0; k < 8; k++) {
        acc[k] += w[k * 4 + 0] * xj0 + w[k * 4 + 1] * xj1 + w[k * 4 + 2] * xj2 +
                  w[k * 4 + 3] * xj3;
      }
      w += 32;
    }

    v128_t acc0_3 = wasm_i32x4_make(acc[0], acc[1], acc[2], acc[3]);
    v128_t acc4_7 = wasm_i32x4_make(acc[4], acc[5], acc[6], acc[7]);
    v128_t scale0_3 = wasm_v128_load(&scale[i]);
    v128_t scale4_7 = wasm_v128_load(&scale[i + 4]);

    wasm_v128_store(&_out[i],
                    wasm_f32x4_mul(wasm_f32x4_convert_i32x4(acc0_3), scale0_3));
    wasm_v128_store(&_out[i + 4],
                    wasm_f32x4_mul(wasm_f32x4_convert_i32x4(acc4_7), scale4_7));
  }
}

#define SCALE (128.f * 127.f)
#define SCALE_1 (1.f / 128.f / 127.f)

#endif /* VEC_WASM_H */

