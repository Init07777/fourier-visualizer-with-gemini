import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Play, 
  Pause, 
  RefreshCw, 
  Info, 
  Download, 
  Settings, 
  Calculator,
  Maximize,
  Delete,
  Lightbulb
} from 'lucide-react';

/**
 * 傅里叶级数可视化应用 (非线性滑块版)
 * * 变更：
 * 1. 优化：N 值滑块采用非线性映射 (二次曲线)。前 5-10 项的调节非常细腻，后面则加快速度。
 * 2. 优化：自动演示动画也加入了动态步长，后期变化稍快，提升观感。
 */

// --- 辅助数学工具 ---

const PI = Math.PI;
const TWO_PI = 2 * PI;

// 解析用户输入的函数字符串
const safeEval = (expr, x) => {
  try {
    // 简单的沙箱机制，增强了 max, min, E 等支持
    const f = new Function(
        'x', 'PI', 'E', 'sin', 'cos', 'tan', 'abs', 'floor', 'ceil', 'sign', 'pow', 'sqrt', 'max', 'min', 
        `return ${expr};`
    );
    return f(
        x, Math.PI, Math.E, Math.sin, Math.cos, Math.tan, Math.abs, Math.floor, Math.ceil, Math.sign, Math.pow, Math.sqrt, Math.max, Math.min
    );
  } catch (e) {
    return 0;
  }
};

// 数值积分计算傅里叶系数 (针对自定义函数优化)
const calculateCoefficientsNumerical = (expr, N, period = TWO_PI) => {
  const L = period / 2;
  // 优化：根据 N 的大小动态调整步长
  const step = 0.02; 
  const coeffs = { a0: 0, an: new Float32Array(N), bn: new Float32Array(N) };
  
  // 预计算 x 和 f(x) 值
  const samples = [];
  for (let x = -L; x < L; x += step) {
    samples.push({ x, val: safeEval(expr, x) });
  }

  const sampleCount = samples.length;
  const invL = 1 / L;
  const constantFactor = invL * step;

  // 计算 a0
  let sumA0 = 0;
  for (let i = 0; i < sampleCount; i++) {
    sumA0 += samples[i].val;
  }
  coeffs.a0 = sumA0 * constantFactor;

  // 计算 an, bn
  for (let n = 1; n <= N; n++) {
    let sumAn = 0;
    let sumBn = 0;
    const k = (n * PI) * invL; 
    
    for (let i = 0; i < sampleCount; i++) {
      const { x, val } = samples[i];
      const angle = k * x;
      sumAn += val * Math.cos(angle);
      sumBn += val * Math.sin(angle);
    }
    coeffs.an[n - 1] = sumAn * constantFactor;
    coeffs.bn[n - 1] = sumBn * constantFactor;
  }
  return coeffs;
};

// --- 主组件 ---

export default function FourierApp() {
  // --- 状态管理 ---
  const [waveType, setWaveType] = useState('square');
  const [nTerms, setNTerms] = useState(5);
  const [isPlaying, setIsPlaying] = useState(false);
  const [customExpr, setCustomExpr] = useState('x * x');
  const [mse, setMse] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  
  // 视图控制状态
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  
  const lastMouseX = useRef(0);
  const lastMouseY = useRef(0);
  
  // 引用容器以绑定原生事件
  const containerRef = useRef(null);
  const zoomRef = useRef(zoom);
  
  // 输入框引用，用于插入文本
  const inputRef = useRef(null);
  
  const canvasRef = useRef(null);
  const animationRef = useRef(null);

  // 基础常量范围
  const BASE_X_RANGE = [-2.0 * PI, 2.0 * PI];
  const BASE_Y_RANGE = [-2.2, 2.2];

  // 推荐函数列表
  const recommendedFunctions = [
    { label: '全波整流', expr: 'abs(sin(x))', desc: '绝对值正弦波' },
    { label: '半波整流', expr: 'max(sin(x), 0)', desc: '截去负半周' },
    { label: '标准抛物线', expr: 'x * x', desc: '二次函数' },
    { label: '绝对值函数', expr: 'abs(x)', desc: 'V字形波' },
    { label: '双音复合', expr: 'sin(x) + sin(2*x)', desc: '基频+二倍频' },
    { label: '高斯脉冲', expr: 'pow(E, -x*x)', desc: '钟形曲线' }
  ];

  // --- 非线性映射逻辑 (核心变更) ---
  
  // 将滑块位置 (0-100) 映射到 N (1-100)
  // 使用二次函数 N = 1 + 99 * (slider/100)^2
  // 效果：滑块在前半段只对应很小的 N 变化，后半段变化加快
  const sliderToN = useCallback((sliderVal) => {
    const s = Math.max(0, Math.min(100, parseFloat(sliderVal)));
    const n = 1 + 99 * Math.pow(s / 100, 2);
    return Math.round(n);
  }, []);

  // 将 N (1-100) 逆映射回滑块位置 (0-100)
  // slider = 100 * sqrt((N-1)/99)
  const nToSlider = useCallback((n) => {
    const val = Math.max(1, Math.min(100, n));
    return 100 * Math.sqrt((val - 1) / 99);
  }, []);

  // 计算当前的 Slider 显示值
  const currentSliderVal = useMemo(() => nToSlider(nTerms), [nTerms, nToSlider]);

  // --- 同步 Zoom 到 Ref ---
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // --- 核心计算逻辑 ---

  const getOriginalValue = useCallback((x, type) => {
    // 周期映射
    let x_periodic = x % TWO_PI;
    const L = PI;
    if (x_periodic > L) x_periodic -= TWO_PI;
    if (x_periodic < -L) x_periodic += TWO_PI;

    switch (type) {
      case 'square':
        return x_periodic >= 0 ? 1 : -1;
      case 'triangle':
        return 1 - 2 * Math.abs(x_periodic) / PI;
      case 'sawtooth':
        return x_periodic / PI;
      case 'custom':
        return safeEval(customExpr, x_periodic);
      default:
        return 0;
    }
  }, [customExpr]);

  // 缓存自定义系数 (N=100)
  const customCoeffs = useMemo(() => {
    if (waveType === 'custom') {
      return calculateCoefficientsNumerical(customExpr, 100);
    }
    return null;
  }, [waveType, customExpr]);

  // 优化的傅里叶求和
  const getFourierValue = useCallback((x, type, N) => {
    let sum = 0;
    
    if (type === 'square') {
      for (let n = 1; n <= N; n++) {
        const k = 2 * n - 1;
        sum += (Math.sin(k * x) / k);
      }
      return sum * (4 / PI);
    } else if (type === 'triangle') {
      for (let n = 1; n <= N; n++) {
        const k = 2 * n - 1;
        sum += Math.cos(k * x) / (k * k);
      }
      return sum * (8 / (PI * PI));
    } else if (type === 'sawtooth') {
      for (let n = 1; n <= N; n++) {
        const sign = (n % 2 === 0) ? -1 : 1;
        sum += (sign / n) * Math.sin(n * x);
      }
      return sum * (2 / PI);
    } else if (type === 'custom' && customCoeffs) {
      sum = customCoeffs.a0 / 2;
      const limit = Math.min(N, customCoeffs.an.length);
      for (let n = 1; n <= limit; n++) {
        const idx = n - 1;
        sum += customCoeffs.an[idx] * Math.cos(n * x) + customCoeffs.bn[idx] * Math.sin(n * x);
      }
      return sum;
    }
    return 0;
  }, [customCoeffs]);

  // --- 绘图逻辑 ---

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    const width = canvas.width;
    const height = canvas.height;

    // 背景填充
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // 计算当前 X 视图范围
    const rangeWidth = (BASE_X_RANGE[1] - BASE_X_RANGE[0]) / zoom;
    const xCenter = (BASE_X_RANGE[0] + BASE_X_RANGE[1]) / 2 + offsetX;
    const currentXMin = xCenter - rangeWidth / 2;
    const currentXMax = xCenter + rangeWidth / 2;

    // 计算当前 Y 视图范围 (加入 offsetY)
    const rangeHeight = (BASE_Y_RANGE[1] - BASE_Y_RANGE[0]) / zoom;
    const yCenter = (BASE_Y_RANGE[0] + BASE_Y_RANGE[1]) / 2 + offsetY;
    const currentYMin = yCenter - rangeHeight / 2;
    const currentYMax = yCenter + rangeHeight / 2;

    const mapX = (val) => ((val - currentXMin) / (currentXMax - currentXMin)) * width;
    const mapY = (val) => height - ((val - currentYMin) / (currentYMax - currentYMin)) * height;

    // 绘制网格
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.strokeStyle = '#f1f5f9';
    
    // 垂直网格 (PI为单位)
    const startPi = Math.floor(currentXMin / PI);
    const endPi = Math.ceil(currentXMax / PI);
    
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "10px sans-serif";
    
    for (let i = startPi; i <= endPi; i++) {
        const val = i * PI;
        const px = mapX(val);
        ctx.moveTo(px, 0);
        ctx.lineTo(px, height);
        if (Math.abs(val) < 100) {
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(`${i}π`, px, mapY(currentYMin) + (height - mapY(currentYMin) < 20 ? -20 : 6));
        }
    }
    
    // 水平网格
    const startY = Math.floor(currentYMin);
    const endY = Math.ceil(currentYMax);
    for (let i = startY; i <= endY; i++) {
        const py = mapY(i);
        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
    }
    ctx.stroke();

    // 坐标轴
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    const yZero = mapY(0);
    const xZero = mapX(0);
    
    // X轴
    if (yZero >= 0 && yZero <= height) {
        ctx.moveTo(0, yZero);
        ctx.lineTo(width, yZero);
    }
    // Y轴
    if (xZero >= 0 && xZero <= width) {
        ctx.moveTo(xZero, 0);
        ctx.lineTo(xZero, height);
    }
    ctx.stroke();

    // 绘制函数
    const step = (currentXMax - currentXMin) / width;
    
    // 原函数
    ctx.beginPath();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    
    let isFirst = true;
    for (let px = 0; px < width; px += 2) {
        const x = currentXMin + (px / width) * (currentXMax - currentXMin);
        const y = getOriginalValue(x, waveType);
        
        const py = mapY(y);
        
        if (!isFirst && Math.abs(y - getOriginalValue(x - step*2, waveType)) > 1.5) {
             ctx.stroke();
             ctx.beginPath();
             ctx.moveTo(px, py);
        } else if (isFirst) {
             ctx.moveTo(px, py);
             isFirst = false;
        } else {
             ctx.lineTo(px, py);
        }
    }
    ctx.stroke();

    // 傅里叶逼近
    ctx.beginPath();
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#3b82f6'); 
    gradient.addColorStop(1, '#8b5cf6');
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2;

    let errorSqSum = 0;
    let count = 0;

    isFirst = true;
    for (let px = 0; px < width; px++) {
        const x = currentXMin + (px / width) * (currentXMax - currentXMin);
        const fY = getFourierValue(x, waveType, nTerms);
        const py = mapY(fY);
        
        if (count % 5 === 0) {
             const oY = getOriginalValue(x, waveType);
             errorSqSum += (oY - fY) * (oY - fY);
        }
        count++;

        if (isFirst) {
            ctx.moveTo(px, py);
            isFirst = false;
        } else {
            ctx.lineTo(px, py);
        }
    }
    ctx.stroke();
    
    if (count > 0) {
        setMse(errorSqSum / (count / 5));
    }

  }, [waveType, nTerms, getOriginalValue, getFourierValue, zoom, offsetX, offsetY]);

  // --- 事件处理 ---

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const width = rect.width;
        
        const ratio = mouseX / width;
        const scaleFactor = 0.1;
        const delta = e.deltaY > 0 ? -scaleFactor : scaleFactor;
        
        const currentZoom = zoomRef.current;
        const newZoom = Math.max(0.1, Math.min(50, currentZoom * (1 + delta)));
        
        if (newZoom !== currentZoom) {
            const baseWidth = BASE_X_RANGE[1] - BASE_X_RANGE[0];
            const adjustment = (ratio - 0.5) * baseWidth * (1/currentZoom - 1/newZoom);
            setZoom(newZoom);
            setOffsetX(prev => prev + adjustment);
        }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const handleMouseDown = (e) => {
    setIsDragging(true);
    lastMouseX.current = e.clientX;
    lastMouseY.current = e.clientY;
  };
  
  const handleMouseMove = (e) => {
    if (!isDragging) return;
    
    const deltaPxX = e.clientX - lastMouseX.current;
    const deltaPxY = e.clientY - lastMouseY.current;
    lastMouseX.current = e.clientX;
    lastMouseY.current = e.clientY;
    
    const canvas = canvasRef.current;
    const rangeWidth = (BASE_X_RANGE[1] - BASE_X_RANGE[0]) / zoom;
    const deltaX = -(deltaPxX / canvas.width) * rangeWidth;
    setOffsetX(prev => prev + deltaX);

    const rangeHeight = (BASE_Y_RANGE[1] - BASE_Y_RANGE[0]) / zoom;
    const deltaY = (deltaPxY / canvas.height) * rangeHeight;
    setOffsetY(prev => prev + deltaY);
  };
  
  const handleMouseUp = () => setIsDragging(false);

  // --- 键盘输入逻辑 ---

  const handleInsertToken = (token) => {
    if (!inputRef.current) return;
    
    const input = inputRef.current;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const value = input.value;
    
    const newValue = value.substring(0, start) + token + value.substring(end);
    setCustomExpr(newValue);
    
    setTimeout(() => {
        input.focus();
        const newCursorPos = start + token.length;
        input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleBackspace = () => {
    if (!inputRef.current) return;
    
    const input = inputRef.current;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const value = input.value;
    
    if (start === end && start > 0) {
        const newValue = value.substring(0, start - 1) + value.substring(end);
        setCustomExpr(newValue);
        setTimeout(() => {
          input.focus();
          input.setSelectionRange(start - 1, start - 1);
        }, 0);
    } else if (start !== end) {
        const newValue = value.substring(0, start) + value.substring(end);
        setCustomExpr(newValue);
        setTimeout(() => {
          input.focus();
          input.setSelectionRange(start, start);
        }, 0);
    }
  };

  const handleClear = () => {
    setCustomExpr('');
    if (inputRef.current) inputRef.current.focus();
  };

  useEffect(() => {
    const handleResize = () => {
        if (canvasRef.current && canvasRef.current.parentElement) {
            canvasRef.current.width = canvasRef.current.parentElement.clientWidth;
            canvasRef.current.height = canvasRef.current.parentElement.clientHeight;
            draw();
        }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  // --- 自动演示动画循环 (增加动态步长) ---
  useEffect(() => {
    if (isPlaying) {
      animationRef.current = setInterval(() => {
        setNTerms(prev => {
          if (prev >= 100) return 1;
          
          // 动态加速：
          // N < 30: 慢速展示 (步长1)
          // N >= 30: 快速展示 (步长2)
          // N >= 70: 极速展示 (步长3)
          let step = 1;
          if (prev >= 70) step = 3;
          else if (prev >= 30) step = 2;
          
          return Math.min(100, prev + step);
        });
      }, 50);
    } else {
      clearInterval(animationRef.current);
    }
    return () => clearInterval(animationRef.current);
  }, [isPlaying]);

  const resetView = () => {
      setZoom(1);
      setOffsetX(0);
      setOffsetY(0);
  };

  const downloadImage = () => {
    const link = document.createElement('a');
    link.download = `fourier_N${nTerms}.png`;
    link.href = canvasRef.current.toDataURL();
    link.click();
  };

  // --- 界面 ---

  return (
    <div className="flex flex-col md:flex-row h-screen bg-slate-50 text-slate-800 font-sans overflow-hidden select-none">
      
      {/* 左侧控制栏 */}
      <div className="w-full md:w-80 bg-white border-r border-slate-200 flex flex-col shadow-xl z-20 overflow-y-auto shrink-0">
        <div className="p-5 space-y-6">
          {/* Header */}
          <div className="flex items-center space-x-2">
            <div className="bg-gradient-to-br from-indigo-500 to-purple-600 p-2 rounded-lg shadow-md">
                <Settings className="w-5 h-5 text-white" />
            </div>
            <div>
                <h1 className="text-lg font-bold text-slate-800 leading-tight">傅里叶级数</h1>
                <p className="text-xs text-slate-400 font-medium">Interactive Visualizer</p>
            </div>
          </div>

          {/* Controls Container */}
          <div className="space-y-5">
            
            {/* 1. Waveform Selection */}
            <div>
                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">函数类型</label>
                <div className="grid grid-cols-2 gap-2">
                    {[
                        { id: 'square', label: '方波' },
                        { id: 'triangle', label: '三角波' },
                        { id: 'sawtooth', label: '锯齿波' },
                        { id: 'custom', label: '自定义' }
                    ].map(type => (
                        <button
                        key={type.id}
                        onClick={() => setWaveType(type.id)}
                        className={`px-3 py-2 text-sm font-medium rounded-lg transition-all border ${
                            waveType === type.id 
                            ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm' 
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                        >
                        {type.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 1.5 Recommended Functions (New) */}
            <div>
                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block flex items-center gap-1">
                    <Lightbulb className="w-3 h-3 text-amber-500" /> 常见函数推荐
                </label>
                <div className="grid grid-cols-2 gap-2">
                    {recommendedFunctions.map((rec) => (
                        <button
                            key={rec.label}
                            onClick={() => {
                                setCustomExpr(rec.expr);
                                setWaveType('custom');
                            }}
                            className="group relative px-3 py-2 text-xs font-medium rounded-lg bg-slate-50 border border-slate-200 text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition-all text-left"
                        >
                            <span className="block truncate">{rec.label}</span>
                            <span className="text-[10px] text-slate-400 font-mono block truncate group-hover:text-indigo-400">{rec.expr}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* Custom Input & Math Keypad */}
            {waveType === 'custom' && (
                <div className="animate-fadeIn">
                    <div className="relative group mb-2">
                        <input 
                            ref={inputRef}
                            type="text" 
                            value={customExpr}
                            onChange={(e) => setCustomExpr(e.target.value)}
                            className="w-full pl-3 pr-9 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-mono text-slate-700 bg-slate-50 focus:bg-white transition-colors"
                            placeholder="输入表达式..."
                        />
                        <Calculator className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
                    </div>
                    
                    {/* Math Keypad */}
                    <div className="grid grid-cols-4 gap-1.5 p-2 bg-slate-100 rounded-xl border border-slate-200">
                        {['x', 'sin(', 'cos(', 'abs(', 'PI', '(', ')', 'pow(', 'sqrt(', '+', '-', '*', '/'].map((token) => (
                             <button
                                key={token}
                                onClick={() => handleInsertToken(token)}
                                className="bg-white border border-slate-300 rounded hover:bg-indigo-50 hover:border-indigo-200 active:scale-95 transition-all text-xs font-mono font-medium py-2 text-slate-700 shadow-sm"
                             >
                                {token.replace('(', '')}
                             </button>
                        ))}
                        <button onClick={handleBackspace} className="bg-slate-200 border border-slate-300 rounded hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all flex items-center justify-center shadow-sm">
                            <Delete className="w-4 h-4" />
                        </button>
                         <button onClick={handleClear} className="col-span-2 bg-slate-200 border border-slate-300 rounded hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all text-xs font-bold text-slate-600 shadow-sm">
                            清空
                        </button>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1 text-center">点击按钮插入符号</p>
                </div>
            )}

            {/* 2. N Slider */}
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200/60">
                <div className="flex justify-between items-end mb-2">
                    <label className="text-sm font-bold text-slate-700">逼近项数 N</label>
                    <div className="text-right">
                        <span className="text-2xl font-bold text-indigo-600 tabular-nums leading-none">{nTerms}</span>
                        <span className="text-xs text-slate-400 ml-1">项</span>
                    </div>
                </div>
                {/* 滑块优化：
                  min=0, max=100, step=0.1 用于提供丝滑的拖动体验。
                  value={currentSliderVal} 显示转换后的滑块位置。
                  onChange 调用 sliderToN 将非线性的滑块位置转换回线性的 N 值。
                */}
                <input 
                    type="range" 
                    min="0" 
                    max="100" 
                    step="0.1"
                    value={currentSliderVal} 
                    onChange={(e) => setNTerms(sliderToN(e.target.value))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-500"
                />
                
                {/* Playback Controls */}
                <div className="grid grid-cols-2 gap-2 mt-4">
                    <button 
                        onClick={() => setIsPlaying(!isPlaying)}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all ${
                            isPlaying 
                            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' 
                            : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md hover:shadow-lg'
                        }`}
                    >
                        {isPlaying ? <Pause className="w-3.5 h-3.5 mr-1.5" /> : <Play className="w-3.5 h-3.5 mr-1.5" />}
                        {isPlaying ? '暂停演示' : '自动演示'}
                    </button>
                    <button 
                            onClick={() => { setIsPlaying(false); setNTerms(1); }}
                            className="flex items-center justify-center py-2 rounded-lg text-xs font-bold text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors"
                    >
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> 重置 N
                    </button>
                </div>
            </div>
            
            {/* Info Box */}
            <div className="bg-indigo-50 rounded-xl p-4 border border-indigo-100">
                <div className="flex items-start">
                    <Info className="w-4 h-4 text-indigo-500 mt-0.5 mr-2 shrink-0" />
                    <p className="text-xs text-indigo-800 leading-relaxed">
                        <strong>交互提示：</strong><br/>
                        • 滚轮缩放视图<br/>
                        • 按住拖动 (上下左右)<br/>
                        • 推荐函数会自动切换模式
                    </p>
                </div>
            </div>

          </div>
        </div>

        <div className="mt-auto border-t border-slate-100 p-4">
            <button 
               onClick={() => setShowHelp(true)}
               className="w-full py-2 text-xs font-medium text-slate-500 hover:text-indigo-600 transition-colors"
            >
                查看数学原理详情
            </button>
        </div>
      </div>

      {/* 右侧可视化区域 */}
      <div className="flex-1 flex flex-col relative bg-slate-100/50">
        
        {/* Top Bar Overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-start pointer-events-none z-10">
            <div className="bg-white/90 backdrop-blur-md p-3 rounded-xl shadow-sm border border-slate-200/60 pointer-events-auto">
                <h2 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                    MSE (均方误差)
                    <span className="bg-slate-100 px-2 py-0.5 rounded text-slate-600 font-mono text-xs">
                        {mse.toFixed(6)}
                    </span>
                </h2>
            </div>

            <div className="flex gap-2 pointer-events-auto">
                 <button 
                    onClick={resetView}
                    className="p-2 bg-white rounded-lg shadow-sm border border-slate-200 text-slate-600 hover:text-indigo-600 hover:bg-slate-50 transition-all tooltip-trigger"
                    title="重置视图"
                 >
                    <Maximize className="w-5 h-5" />
                 </button>
                 <button 
                    onClick={downloadImage}
                    className="p-2 bg-white rounded-lg shadow-sm border border-slate-200 text-slate-600 hover:text-indigo-600 hover:bg-slate-50 transition-all"
                    title="下载图像"
                 >
                    <Download className="w-5 h-5" />
                 </button>
            </div>
        </div>

        {/* Canvas Area */}
        <div 
            ref={containerRef}
            className={`flex-1 relative overflow-hidden ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
             <canvas 
                ref={canvasRef}
                className="w-full h-full block touch-none"
             />
             
             {/* Dynamic Labels */}
             <div className="absolute bottom-4 right-4 bg-white/80 px-2 py-1 rounded text-[10px] text-slate-500 font-mono pointer-events-none backdrop-blur-sm">
                Scale: {zoom.toFixed(2)}x
             </div>
        </div>
      </div>

      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl p-6 animate-scaleIn">
                <div className="flex justify-between items-center mb-4 border-b border-slate-100 pb-4">
                    <h3 className="text-lg font-bold text-slate-800">傅里叶级数原理</h3>
                    <button onClick={() => setShowHelp(false)} className="text-slate-400 hover:text-slate-600 p-1">
                        ✕
                    </button>
                </div>
                <div className="space-y-4 text-sm text-slate-600">
                    <p>任何周期函数 <i>f(x)</i> 都可以分解为正弦波和余弦波的叠加：</p>
                    
                    {/* 使用 HTML/CSS 替代 raw LaTeX 字符串，解决显示问题 */}
                    <div className="bg-slate-50 p-4 rounded-lg font-serif text-center text-slate-800 my-2 text-lg">
                        <i>f(x)</i> ≈ <span className="italic">a</span><sub>0</sub>/2 + 
                        <span className="inline-block mx-1 transform scale-125 font-sans">Σ</span>
                        [<span className="italic">a</span><sub>n</sub>cos(nx) + <span className="italic">b</span><sub>n</sub>sin(nx)]
                    </div>

                    <ul className="space-y-2">
                        <li className="flex gap-2">
                            <span className="font-bold text-indigo-600 shrink-0">方波:</span>
                            <span>只包含奇次谐波，幅度随 1/n 衰减。收敛较慢，吉布斯现象明显。</span>
                        </li>
                        <li className="flex gap-2">
                            <span className="font-bold text-indigo-600 shrink-0">三角波:</span>
                            <span>只包含奇次谐波，但幅度随 1/n² 衰减。收敛非常快。</span>
                        </li>
                    </ul>
                </div>
                <button 
                    onClick={() => setShowHelp(false)}
                    className="mt-6 w-full bg-indigo-600 text-white py-2.5 rounded-xl hover:bg-indigo-700 transition-colors font-bold shadow-lg shadow-indigo-200"
                >
                    关闭
                </button>
            </div>
        </div>
      )}
    </div>
  );
}
